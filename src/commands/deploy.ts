import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { promisify } from "node:util";
import type { AizuConfig } from "../config.js";
import { generateTypeScript, generateRust } from "../codegen.js";
import * as log from "../logger.js";

const exec = promisify(execFile);

interface DeployOptions {
  apiKey: string;
  verbose: boolean;
}

export async function deploy(config: AizuConfig, opts: DeployOptions) {
  const start = performance.now();
  let totalSteps = config.schemas ? 5 : 4;
  totalSteps++; // Always sync settings
  let stepNum = 0;

  // Step: Codegen
  if (config.schemas) {
    stepNum++;
    log.step(stepNum, totalSteps, "Running codegen");
    await runCodegen(config, opts);
  }

  // Step: Build WASM
  stepNum++;
  log.step(stepNum, totalSteps, "Building WASM");
  await buildWasm(config, opts);

  // Step: Locate .wasm file
  stepNum++;
  log.step(stepNum, totalSteps, "Locating WASM artifact");
  const wasmPath = await findWasmFile(config);
  const size = (await readFile(wasmPath)).byteLength;
  log.success(`Found ${basename(wasmPath)} (${formatBytes(size)})`);

  // Step: Upload
  stepNum++;
  log.step(stepNum, totalSteps, "Uploading module");
  const moduleId = await uploadWasm(config, wasmPath, opts);

  // Step: Wait for ready
  stepNum++;
  log.step(stepNum, totalSteps, "Waiting for module to be ready");
  await waitForReady(config, moduleId, opts);

  // Step: Sync settings (always runs, even if empty, to clear removed settings)
  stepNum++;
  log.step(stepNum, totalSteps, "Syncing settings");
  await syncSettings(config, opts);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log();
  log.success(`Deploy complete in ${elapsed}s`);
}

async function runCodegen(config: AizuConfig, _opts: DeployOptions) {
  const schemas = config.schemas!;

  if (!existsSync(schemas.path)) {
    log.warn(`Schemas directory not found: ${schemas.path}, skipping codegen`);
    return;
  }

  // Generate Rust types (mod.rs + dashboard.rs)
  await generateRust(schemas.path, schemas.output);

  // Generate TypeScript types
  if (schemas.ts_output) {
    await generateTypeScript(schemas.path, schemas.ts_output);
  }
}

async function buildWasm(config: AizuConfig, opts: DeployOptions) {
  const s = log.spinner("Compiling...");
  try {
    await run(
      "cargo",
      ["build", "--release", "--target", "wasm32-wasip1"],
      opts,
      { cwd: config.functions.path }
    );
    s.stop("WASM build succeeded");
  } catch (err) {
    s.fail("WASM build failed");
    throw err;
  }
}

async function findWasmFile(config: AizuConfig): Promise<string> {
  const releaseDir = resolve(
    config.functions.path,
    "target",
    "wasm32-wasip1",
    "release"
  );

  if (!existsSync(releaseDir)) {
    throw new Error(`Release directory not found: ${releaseDir}`);
  }

  const files = await readdir(releaseDir);
  const wasmFiles = files.filter(
    (f) => f.endsWith(".wasm") && !f.endsWith(".d.wasm")
  );

  if (wasmFiles.length === 0) {
    throw new Error(`No .wasm file found in ${releaseDir}`);
  }
  if (wasmFiles.length > 1) {
    throw new Error(
      `Multiple .wasm files found in ${releaseDir}: ${wasmFiles.join(", ")}`
    );
  }

  return resolve(releaseDir, wasmFiles[0]);
}

async function uploadWasm(
  config: AizuConfig,
  wasmPath: string,
  opts: DeployOptions
): Promise<string> {
  const headers = authHeaders(config, opts);

  // Check if module already exists
  const listRes = await fetch(`${config.project.url}/api/v1/modules`, {
    headers,
  });

  if (!listRes.ok) {
    throw new Error(
      `Failed to list modules: ${listRes.status} ${await listRes.text()}`
    );
  }

  const { data: modules } = (await listRes.json()) as {
    data: Array<{ id: string; name: string }>;
  };
  const existing = modules.find((m) => m.name === config.project.name);

  let moduleId: string;

  if (existing) {
    moduleId = existing.id;
    log.detail(`Module "${config.project.name}" exists (${moduleId})`);
  } else {
    // Create module
    const createRes = await fetch(`${config.project.url}/api/v1/modules`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: config.project.name, version: "1.0.0" }),
    });

    if (!createRes.ok) {
      throw new Error(
        `Failed to create module: ${createRes.status} ${await createRes.text()}`
      );
    }

    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };
    moduleId = created.id;
    log.detail(`Created module "${config.project.name}" (${moduleId})`);
  }

  // Upload WASM binary
  const wasmBytes = await readFile(wasmPath);
  const s = log.spinner("Uploading...");

  const uploadRes = await fetch(
    `${config.project.url}/api/v1/modules/${moduleId}/upload`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/wasm" },
      body: wasmBytes,
    }
  );

  if (!uploadRes.ok) {
    s.fail("Upload failed");
    throw new Error(
      `Failed to upload: ${uploadRes.status} ${await uploadRes.text()}`
    );
  }

  s.stop(`Uploaded ${formatBytes(wasmBytes.byteLength)}`);
  return moduleId;
}

async function waitForReady(
  config: AizuConfig,
  moduleId: string,
  opts: DeployOptions
) {
  const headers = authHeaders(config, opts);
  const s = log.spinner("Processing...");

  for (let i = 0; i < 60; i++) {
    await sleep(1000);

    const res = await fetch(
      `${config.project.url}/api/v1/modules/${moduleId}`,
      { headers }
    );

    if (!res.ok) {
      s.fail("Failed to check module status");
      throw new Error(`Status check failed: ${res.status}`);
    }

    const { data: mod } = (await res.json()) as {
      data: { status: string; functions_count?: number; error?: string };
    };

    if (mod.status === "ready") {
      s.stop(
        `Module is ready${mod.functions_count != null ? ` (${mod.functions_count} functions)` : ""}`
      );
      return;
    }

    if (mod.status === "error") {
      s.fail(`Module failed: ${mod.error ?? "unknown error"}`);
      throw new Error(`Module processing failed: ${mod.error}`);
    }
  }

  s.fail("Timed out waiting for module to be ready");
  throw new Error("Module processing timed out after 60s");
}

async function syncSettings(config: AizuConfig, opts: DeployOptions) {
  const headers = authHeaders(config, opts);

  const body: Record<string, unknown> = {};
  if (config.auth) {
    body.auth = config.auth;
  }

  const res = await fetch(`${config.project.url}/api/v1/settings`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to sync settings: ${res.status} ${await res.text()}`
    );
  }

  const { synced } = (await res.json()) as { ok: boolean; synced: Record<string, unknown> };
  if (synced.auth) {
    log.success("Auth settings synced");
  } else {
    log.success("Settings synced (auth disabled)");
  }
}

function authHeaders(
  config: AizuConfig,
  opts: DeployOptions
): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.apiKey}`,
    "X-Aizu-Project": config.project.name,
  };
}

async function run(
  cmd: string,
  args: string[],
  opts: DeployOptions,
  execOpts?: { cwd?: string }
) {
  if (opts.verbose) {
    log.detail(`$ ${cmd} ${args.join(" ")}`);
  }

  try {
    return await exec(cmd, args, {
      cwd: execOpts?.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const msg = e.stderr?.trim() || e.message || "Unknown error";
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
