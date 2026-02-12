import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import * as log from "../logger.js";

// ---------------------------------------------------------------------------
// Registry config
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY = "https://pkg.aizu.sh";

interface PkgConfig {
  registry: string;
  token?: string;
}

async function loadPkgConfig(): Promise<PkgConfig> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const path = resolve(home, ".aizu", "config.toml");

  if (!existsSync(path)) {
    return { registry: DEFAULT_REGISTRY };
  }

  const raw = await readFile(path, "utf-8");
  const parsed = parse(raw) as {
    registry?: { url?: string; token?: string };
  };

  return {
    registry: parsed.registry?.url ?? DEFAULT_REGISTRY,
    token: parsed.registry?.token,
  };
}

async function savePkgConfig(cfg: PkgConfig) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const dir = resolve(home, ".aizu");
  await mkdir(dir, { recursive: true });

  const content = `[registry]\nurl = "${cfg.registry}"\n${cfg.token ? `token = "${cfg.token}"\n` : ""}`;
  await writeFile(resolve(dir, "config.toml"), content);
}

// ---------------------------------------------------------------------------
// Registry client
// ---------------------------------------------------------------------------

async function registryFetch(
  cfg: PkgConfig,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const url = `${cfg.registry.replace(/\/+$/, "")}/api/v1${path}`;
  return fetch(url, opts);
}

async function registryGet<T>(cfg: PkgConfig, path: string): Promise<T> {
  const res = await registryFetch(cfg, path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `registry returned ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// TOML helpers
// ---------------------------------------------------------------------------

interface AizuToml {
  project: { name: string; url: string };
  functions?: { path: string };
  schemas?: { path: string; output?: string; ts_output?: string };
  auth?: Record<string, unknown>;
  packages?: Record<string, string | { version?: string; path?: string; git?: string; branch?: string; tag?: string }>;
}

async function readAizuToml(cwd: string): Promise<{ data: AizuToml; raw: string }> {
  const path = resolve(cwd, "aizu.toml");
  if (!existsSync(path)) {
    throw new Error("aizu.toml not found — are you in an Aizu project?");
  }
  const raw = await readFile(path, "utf-8");
  const data = parse(raw) as unknown as AizuToml;
  return { data, raw };
}

function serializeAizuToml(data: AizuToml): string {
  let out = "";

  out += `[project]\nname = "${data.project.name}"\nurl = "${data.project.url}"\n`;

  if (data.functions) {
    out += `\n[functions]\npath = "${data.functions.path}"\n`;
  }

  if (data.schemas) {
    out += `\n[schemas]\npath = "${data.schemas.path}"\n`;
    if (data.schemas.output) out += `output = "${data.schemas.output}"\n`;
    if (data.schemas.ts_output) out += `ts_output = "${data.schemas.ts_output}"\n`;
  }

  if (data.auth) {
    out += `\n[auth]\n`;
    for (const [k, v] of Object.entries(data.auth)) {
      out += `${k} = ${typeof v === "string" ? `"${v}"` : v}\n`;
    }
  }

  if (data.packages && Object.keys(data.packages).length > 0) {
    out += `\n[packages]\n`;
    for (const [name, dep] of Object.entries(data.packages)) {
      if (typeof dep === "string") {
        out += `${name} = "${dep}"\n`;
      } else {
        const parts: string[] = [];
        if (dep.version) parts.push(`version = "${dep.version}"`);
        if (dep.path) parts.push(`path = "${dep.path}"`);
        if (dep.git) parts.push(`git = "${dep.git}"`);
        if (dep.branch) parts.push(`branch = "${dep.branch}"`);
        if (dep.tag) parts.push(`tag = "${dep.tag}"`);
        out += `${name} = { ${parts.join(", ")} }\n`;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function add(
  cwd: string,
  name: string,
  flags: { version?: string; path?: string; git?: string; branch?: string; tag?: string },
) {
  const { data } = await readAizuToml(cwd);

  if (!data.packages) data.packages = {};

  if (flags.path) {
    data.packages[name] = { path: flags.path };
  } else if (flags.git) {
    const dep: Record<string, string> = { git: flags.git };
    if (flags.branch) dep.branch = flags.branch;
    if (flags.tag) dep.tag = flags.tag;
    data.packages[name] = dep as typeof data.packages[string];
  } else {
    data.packages[name] = flags.version ?? "*";
  }

  await writeFile(resolve(cwd, "aizu.toml"), serializeAizuToml(data));

  log.success(`Added package '${name}'`);
  log.info("Run `npx aizu install` to install packages");
}

export async function remove(cwd: string, name: string) {
  const { data } = await readAizuToml(cwd);

  if (!data.packages?.[name]) {
    log.error(`Package '${name}' is not in [packages]`);
    process.exit(1);
  }

  delete data.packages[name];

  await writeFile(resolve(cwd, "aizu.toml"), serializeAizuToml(data));

  log.success(`Removed package '${name}'`);
  log.info("Run `npx aizu install` to update");
}

export async function install(cwd: string) {
  const { data } = await readAizuToml(cwd);
  const packages = data.packages ?? {};
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    log.info("No packages to install.");
    return;
  }

  const cfg = await loadPkgConfig();
  const functionsPath = resolve(cwd, data.functions?.path ?? "./aizu");
  const schemasPath = resolve(functionsPath, data.schemas?.path ?? "schemas/");
  const cacheDir = resolve(
    process.env.HOME ?? process.env.USERPROFILE ?? "~",
    ".aizu",
    "packages",
  );
  await mkdir(cacheDir, { recursive: true });

  log.step(1, 4, `Resolving ${entries.length} package(s)`);

  // Resolve and download each package
  const resolved: { name: string; version: string; source: string; localPath: string }[] = [];

  for (const [name, dep] of entries) {
    if (typeof dep === "object" && dep.path) {
      // Path dependency — use directly
      const localPath = resolve(cwd, dep.path);
      if (!existsSync(localPath)) {
        throw new Error(`Path dependency not found: ${localPath}`);
      }
      const pkgToml = await readFile(resolve(localPath, "aizu-pkg.toml"), "utf-8").catch(() => "");
      const version = pkgToml ? ((parse(pkgToml) as { package?: { version?: string } }).package?.version ?? "0.0.0") : "0.0.0";
      resolved.push({ name, version, source: `path:${dep.path}`, localPath });
      log.detail(`${name} -> ${dep.path} (local)`);
      continue;
    }

    if (typeof dep === "object" && dep.git) {
      // Git dependency
      const dest = resolve(cacheDir, `${name}-git`);
      if (!existsSync(dest)) {
        log.detail(`Cloning ${name} from ${dep.git}`);
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const args = ["clone", "--depth=1"];
        if (dep.branch) args.push("--branch", dep.branch);
        if (dep.tag) args.push("--branch", dep.tag);
        args.push(dep.git, dest);
        await exec("git", args);
      }
      resolved.push({ name, version: "0.0.0", source: `git:${dep.git}`, localPath: dest });
      log.detail(`${name} -> git (cached)`);
      continue;
    }

    // Registry dependency
    const versionReq = typeof dep === "string" ? dep : dep.version ?? "*";

    // Get package info from registry
    const info = await registryGet<{
      versions: { version: string; yanked: boolean }[];
    }>(cfg, `/packages/${name}`).catch(() => {
      throw new Error(`Package '${name}' not found in registry`);
    });

    // Find latest matching version
    const available = info.versions
      .filter((v) => !v.yanked)
      .map((v) => v.version)
      .sort(compareSemver)
      .reverse();

    const matched = versionReq === "*"
      ? available[0]
      : available.find((v) => semverMatches(v, versionReq));

    if (!matched) {
      throw new Error(`No compatible version of '${name}' for requirement '${versionReq}'`);
    }

    // Download if not cached
    const dest = resolve(cacheDir, `${name}-${matched}`);
    if (!existsSync(dest)) {
      log.detail(`Downloading ${name}@${matched}`);
      const res = await registryFetch(cfg, `/packages/${name}/${matched}/download`);
      if (!res.ok) throw new Error(`Failed to download ${name}@${matched}`);
      const tarball = Buffer.from(await res.arrayBuffer());
      await extractTarball(tarball, dest);
    }

    resolved.push({ name, version: matched, source: "registry", localPath: dest });
    log.detail(`${name}@${matched}`);
  }

  // Sync Cargo.toml
  log.step(2, 4, "Syncing Cargo.toml");
  await syncCargoToml(resolve(functionsPath, "Cargo.toml"), resolved);

  // Merge schemas
  log.step(3, 4, "Merging schemas");
  await mergeSchemas(schemasPath, resolved);

  // Generate install stubs
  log.step(4, 4, "Generating install stubs");
  await generateInstallStubs(functionsPath, resolved);

  // Write lockfile
  await writeLockfile(cwd, resolved);

  console.log();
  log.success(`Installed ${resolved.length} package(s)`);
  for (const pkg of resolved) {
    log.detail(`+ ${pkg.name}@${pkg.version} (${pkg.source})`);
  }
}

export async function publish(cwd: string) {
  const pkgTomlPath = resolve(cwd, "aizu-pkg.toml");
  if (!existsSync(pkgTomlPath)) {
    throw new Error("aizu-pkg.toml not found — are you in a package directory?");
  }

  const cfg = await loadPkgConfig();
  if (!cfg.token) {
    throw new Error("Not authenticated — run `npx aizu login` first");
  }

  const raw = await readFile(pkgTomlPath, "utf-8");
  const manifest = parse(raw) as {
    package: { name: string; version: string; description?: string; repository?: string };
  };

  const name = manifest.package.name;
  const version = manifest.package.version;

  log.info(`Packing ${name}@${version}...`);

  const tarball = await createTarball(cwd);

  log.info(`Publishing to registry (${tarball.length} bytes)...`);

  const meta = JSON.stringify({
    name,
    version,
    description: manifest.package.description ?? "",
    repository: manifest.package.repository ?? "",
    manifest: raw,
  });
  const metaBytes = Buffer.from(meta, "utf-8");
  const metaLen = Buffer.alloc(4);
  metaLen.writeUInt32BE(metaBytes.length);

  const payload = Buffer.concat([metaLen, metaBytes, tarball]);

  const res = await registryFetch(cfg, `/packages/${name}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/octet-stream",
    },
    body: payload,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `publish failed: ${res.status}`);
  }

  log.success(`Published ${name}@${version}`);
}

export async function search(query: string) {
  const cfg = await loadPkgConfig();
  const result = await registryGet<{
    packages: { name: string; description: string; latest_version: string; downloads: number }[];
    total: number;
  }>(cfg, `/packages?q=${encodeURIComponent(query)}`);

  if (result.packages.length === 0) {
    log.info(`No packages found for '${query}'`);
    return;
  }

  console.log(`\n  ${result.total} result(s) for '${query}':\n`);
  for (const pkg of result.packages) {
    console.log(`  ${pkg.name} v${pkg.latest_version} — ${pkg.description}`);
  }
  console.log();
}

export async function info(name: string) {
  const cfg = await loadPkgConfig();
  const result = await registryGet<{
    name: string;
    description: string;
    repository: string;
    owners: string[];
    versions: { version: string; yanked: boolean; created_at: string }[];
  }>(cfg, `/packages/${name}`);

  console.log(`\n  ${result.name}\n`);
  if (result.description) console.log(`  ${result.description}\n`);
  if (result.repository) console.log(`  repo: ${result.repository}`);
  console.log(`  owners: ${result.owners.join(", ")}`);
  console.log(`\n  Versions:`);
  for (const v of result.versions) {
    const yanked = v.yanked ? " (yanked)" : "";
    console.log(`    ${v.version} — ${v.created_at}${yanked}`);
  }
  console.log();
}

export async function list(cwd: string) {
  const { data } = await readAizuToml(cwd);
  const packages = data.packages ?? {};
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    log.info("No packages installed.");
    return;
  }

  console.log(`\n  ${entries.length} package(s):\n`);
  for (const [name, dep] of entries) {
    const detail =
      typeof dep === "string"
        ? dep
        : dep.path
          ? `path:${dep.path}`
          : dep.git
            ? `git:${dep.git}`
            : dep.version ?? "*";
    console.log(`  ${name} ${detail}`);
  }
  console.log();
}

export async function login(registryUrl?: string) {
  const cfg = await loadPkgConfig();
  if (registryUrl) cfg.registry = registryUrl;

  const rl = await import("node:readline/promises");
  const io = rl.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  Log in to ${cfg.registry}\n`);
  const username = await io.question("  Username: ");
  const password = await io.question("  Password: ");
  io.close();

  const res = await registryFetch(cfg, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "login failed");
  }

  const { token } = (await res.json()) as { token: string };
  cfg.token = token;
  await savePkgConfig(cfg);

  console.log();
  log.success(`Logged in as ${username}`);
}

export async function register(registryUrl?: string) {
  const cfg = await loadPkgConfig();
  if (registryUrl) cfg.registry = registryUrl;

  const rl = await import("node:readline/promises");
  const io = rl.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  Register on ${cfg.registry}\n`);
  const username = await io.question("  Username: ");
  const email = await io.question("  Email: ");
  const password = await io.question("  Password: ");
  io.close();

  const res = await registryFetch(cfg, "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "registration failed");
  }

  const { token } = (await res.json()) as { token: string };
  cfg.token = token;
  await savePkgConfig(cfg);

  console.log();
  log.success(`Registered and logged in as ${username}`);
}

// ---------------------------------------------------------------------------
// Cargo.toml sync
// ---------------------------------------------------------------------------

async function syncCargoToml(
  cargoPath: string,
  resolved: { name: string; localPath: string }[],
) {
  if (!existsSync(cargoPath)) return;

  let content = await readFile(cargoPath, "utf-8");

  // Remove old aizu-pkg-* lines
  const lines = content.split("\n");
  const filtered = lines.filter((l) => !l.match(/^aizu-pkg-\S+\s*=/));
  content = filtered.join("\n");

  // Ensure [dependencies] section exists
  if (!content.includes("[dependencies]")) {
    content += "\n[dependencies]\n";
  }

  // Add package deps before any section that comes after [dependencies]
  const depLines: string[] = [];
  for (const pkg of resolved) {
    const crateName = `aizu-pkg-${pkg.name}`;
    depLines.push(`${crateName} = { path = "${pkg.localPath}" }`);
  }

  if (depLines.length > 0) {
    // Insert after [dependencies] line
    const idx = content.indexOf("[dependencies]");
    const afterIdx = content.indexOf("\n", idx) + 1;
    content =
      content.slice(0, afterIdx) +
      depLines.join("\n") +
      "\n" +
      content.slice(afterIdx);
  }

  await writeFile(cargoPath, content);
}

// ---------------------------------------------------------------------------
// Schema merge
// ---------------------------------------------------------------------------

async function mergeSchemas(
  schemasDir: string,
  resolved: { name: string; localPath: string }[],
) {
  await mkdir(schemasDir, { recursive: true });

  // Clean old _pkg_* schemas
  if (existsSync(schemasDir)) {
    const files = await readdir(schemasDir);
    for (const f of files) {
      if (f.startsWith("_pkg_")) {
        await rm(resolve(schemasDir, f));
      }
    }
  }

  // Copy schemas from each package
  for (const pkg of resolved) {
    const pkgSchemas = resolve(pkg.localPath, "schemas");
    if (!existsSync(pkgSchemas)) continue;

    const files = await readdir(pkgSchemas);
    for (const f of files) {
      if (!f.endsWith(".toml")) continue;
      const dest = resolve(schemasDir, `_pkg_${pkg.name}_${f}`);
      await cp(resolve(pkgSchemas, f), dest);
      log.detail(`Schema: _pkg_${pkg.name}_${f}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Install stubs
// ---------------------------------------------------------------------------

async function generateInstallStubs(
  functionsDir: string,
  resolved: { name: string; version: string }[],
) {
  if (resolved.length === 0) return;

  const srcDir = resolve(functionsDir, "src");
  await mkdir(srcDir, { recursive: true });

  let code = "// Auto-generated by `aizu install` — do not edit.\n";
  code += "// Ensures all package functions are linked into the WASM binary.\n\n";

  for (const pkg of resolved) {
    const crateName = `aizu_pkg_${pkg.name.replace(/-/g, "_")}`;
    code += `// ${pkg.name} v${pkg.version}\n`;
    code += `${crateName}::install!();\n\n`;
  }

  await writeFile(resolve(srcDir, "_aizu_packages.rs"), code);
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

async function writeLockfile(
  cwd: string,
  resolved: { name: string; version: string; source: string }[],
) {
  let content = "# Auto-generated by `aizu install`. Do not edit.\n\n";
  for (const pkg of resolved) {
    content += `[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version}"\nsource = "${pkg.source}"\n\n`;
  }
  await writeFile(resolve(cwd, "aizu-pkg.lock"), content);
}

// ---------------------------------------------------------------------------
// Tarball helpers (minimal, no external deps)
// ---------------------------------------------------------------------------

async function createTarball(dir: string): Promise<Buffer> {
  // Use tar + gzip via child process — simplest approach without adding npm deps
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { tmpdir } = await import("node:os");

  const outFile = resolve(tmpdir(), `aizu-pkg-${Date.now()}.tar.gz`);

  // Include: aizu-pkg.toml, Cargo.toml, src/, schemas/, README.md, LICENSE
  const includes: string[] = [];
  for (const f of ["aizu-pkg.toml", "Cargo.toml", "README.md", "LICENSE"]) {
    if (existsSync(resolve(dir, f))) includes.push(f);
  }
  if (existsSync(resolve(dir, "src"))) includes.push("src");
  if (existsSync(resolve(dir, "schemas"))) includes.push("schemas");

  await exec("tar", ["czf", outFile, "-C", dir, ...includes]);

  const data = await readFile(outFile);
  await rm(outFile);
  return data;
}

async function extractTarball(data: Buffer, dest: string) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { tmpdir } = await import("node:os");

  await mkdir(dest, { recursive: true });

  const tmpFile = resolve(tmpdir(), `aizu-pkg-${Date.now()}.tar.gz`);
  await writeFile(tmpFile, data);
  await exec("tar", ["xzf", tmpFile, "-C", dest]);
  await rm(tmpFile);
}

// ---------------------------------------------------------------------------
// Semver helpers (minimal, no external deps)
// ---------------------------------------------------------------------------

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^[=^~v]/, "").split(".");
  return [
    parseInt(parts[0] ?? "0", 10),
    parseInt(parts[1] ?? "0", 10),
    parseInt(parts[2] ?? "0", 10),
  ];
}

function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

function semverMatches(version: string, req: string): boolean {
  if (req === "*") return true;
  const [v1, v2, v3] = parseSemver(version);
  const [r1, r2, r3] = parseSemver(req);

  if (req.startsWith("^")) {
    // ^X.Y.Z: >=X.Y.Z, <(X+1).0.0
    if (v1 !== r1) return false;
    return v2 > r2 || (v2 === r2 && v3 >= r3);
  }
  if (req.startsWith("~")) {
    // ~X.Y.Z: >=X.Y.Z, <X.(Y+1).0
    if (v1 !== r1 || v2 !== r2) return false;
    return v3 >= r3;
  }
  if (req.startsWith(">=")) {
    return compareSemver(version, req) >= 0;
  }

  // Exact match (or treat plain version as ^)
  if (v1 !== r1) return false;
  return v2 > r2 || (v2 === r2 && v3 >= r3);
}
