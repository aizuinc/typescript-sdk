import { existsSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { promisify } from "node:util";
import * as log from "../logger.js";

const exec = promisify(execFile);

interface InitOptions {
  name?: string;
  verbose: boolean;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export async function init(cwd: string, opts: InitOptions) {
  const projectName = opts.name ?? basename(cwd);

  // Guard: don't overwrite existing aizu.toml
  if (existsSync(resolve(cwd, "aizu.toml"))) {
    log.error("aizu.toml already exists in this directory");
    process.exit(1);
  }

  const pm = detectPackageManager(cwd);
  log.info(`Using package manager: ${pm}`);
  log.info(`Project name: ${projectName}`);

  const functionsDir = resolve(cwd, "aizu");
  const schemasDir = resolve(functionsDir, "schemas");
  const srcDir = resolve(functionsDir, "src");
  const generatedDir = resolve(srcDir, "generated");

  // Create directories
  await mkdir(generatedDir, { recursive: true });
  await mkdir(schemasDir, { recursive: true });

  // Write all files in parallel
  await Promise.all([
    // aizu.toml
    writeFile(
      resolve(cwd, "aizu.toml"),
      aizuToml(projectName),
    ),

    // Cargo.toml
    writeFile(
      resolve(functionsDir, "Cargo.toml"),
      cargoToml(projectName),
    ),

    // rust-toolchain.toml
    writeFile(
      resolve(functionsDir, "rust-toolchain.toml"),
      rustToolchain(),
    ),

    // src/lib.rs
    writeFile(resolve(srcDir, "lib.rs"), libRs()),

    // src/generated/mod.rs (placeholder)
    writeFile(resolve(generatedDir, "mod.rs"), generatedMod()),

    // src/generated/dashboard.rs (placeholder)
    writeFile(resolve(generatedDir, "dashboard.rs"), generatedDashboard()),

    // schemas/User.toml (auth schema)
    writeFile(resolve(schemasDir, "User.toml"), userSchema()),
  ]);

  log.success("Created aizu.toml");
  log.success("Created aizu/ functions crate");
  log.success("Created aizu/schemas/User.toml (auth schema)");

  // Check for cargo
  if (!commandExists("cargo")) {
    log.warn(
      "cargo not found — install Rust from https://rustup.rs to build functions",
    );
  }

  // Install aizu
  console.log();
  log.info(`Installing aizu...`);
  const installCmd = installCommand(pm);
  log.detail(`$ ${installCmd}`);

  try {
    const parts = installCmd.split(" ");
    await exec(parts[0], parts.slice(1), { cwd });
    log.success("Installed aizu");
  } catch {
    log.warn("Could not install aizu — run manually:");
    log.detail(installCmd);
  }

  // Done
  console.log();
  log.success("Project initialized!");
  console.log();
  console.log("  Next steps:");
  console.log("    1. Define your schemas in aizu/schemas/");
  console.log("    2. Write your functions in aizu/src/lib.rs");
  console.log(
    "    3. Deploy with: AIZU_DEPLOY_KEY=<key> npx aizu deploy",
  );
  console.log();
}

function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(resolve(cwd, "bun.lockb")) || existsSync(resolve(cwd, "bun.lock"))) return "bun";
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function installCommand(pm: PackageManager): string {
  switch (pm) {
    case "bun":
      return "bun add aizu";
    case "pnpm":
      return "pnpm add aizu";
    case "yarn":
      return "yarn add aizu";
    case "npm":
      return "npm install aizu";
  }
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function aizuToml(name: string): string {
  return `[project]
name = "${name}"
url = "http://localhost:4000"

[functions]
path = "./aizu"

[schemas]
path = "schemas/"
output = "src/generated/"
ts_output = "src/generated/"
`;
}

function cargoToml(name: string): string {
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
aizu = "0.1"
serde = { version = "1.0", default-features = false, features = ["derive", "alloc"] }

[profile.release]
opt-level = "s"
lto = true
`;
}

function rustToolchain(): string {
  return `[toolchain]
channel = "stable"
targets = ["wasm32-wasip1"]
`;
}

function libRs(): string {
  return `#![no_std]

use aizu::prelude::*;

mod generated;
pub use generated::*;

#[query]
pub fn hello(ctx: &Ctx) -> String {
    ctx.log.info("Hello from Aizu!");
    String::from("Hello, world!")
}
`;
}

function generatedMod(): string {
  return `// Auto-generated from schemas/*.toml - do not edit
// Run \`npx aizu deploy\` to regenerate.

use aizu::prelude::*;

pub mod dashboard;
`;
}

function generatedDashboard(): string {
  return `// Auto-generated dashboard queries - do not edit
// Run \`npx aizu deploy\` to regenerate.

use super::*;
`;
}

function userSchema(): string {
  return `# Aizu Auth Schema - DO NOT EDIT
# This schema is managed by Aizu for authentication.
# You can EXTEND User fields in other schema files.

[User]
fields = [
    { name = "email", type = "string" },
    { name = "name", type = "string?" },
    { name = "image", type = "string?" },
    { name = "email_verified_at", type = "datetime?" },
    { name = "created_at", type = "datetime" },
    { name = "updated_at", type = "datetime" },
]
indexes = [
    { fields = ["email"], unique = true },
]

[Credential]
response = false
fields = [
    { name = "user_id", type = "id<User>" },
    { name = "hashed_password", type = "string" },
    { name = "created_at", type = "datetime" },
    { name = "updated_at", type = "datetime" },
]
indexes = [
    { fields = ["user_id"], unique = true },
]

[Session]
fields = [
    { name = "user_id", type = "id<User>" },
    { name = "token", type = "string" },
    { name = "expires_at", type = "datetime" },
    { name = "user_agent", type = "string?" },
    { name = "ip_address", type = "string?" },
    { name = "last_used_at", type = "datetime?" },
    { name = "created_at", type = "datetime" },
]
indexes = [
    { fields = ["user_id"] },
    { fields = ["token"], unique = true },
]

[VerificationToken]
fields = [
    { name = "user_id", type = "id<User>?" },
    { name = "identifier", type = "string" },
    { name = "token", type = "string" },
    { name = "token_type", type = "string" },
    { name = "expires_at", type = "datetime" },
    { name = "created_at", type = "datetime" },
]
indexes = [
    { fields = ["token"] },
    { fields = ["user_id"] },
    { fields = ["identifier", "token_type"] },
]
`;
}
