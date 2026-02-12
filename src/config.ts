import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";

export interface AuthConfig {
  password: boolean;
  magic_link: boolean;
  email_verification: boolean;
  password_reset: boolean;
}

export interface AizuConfig {
  project: {
    name: string;
    url: string;
  };
  functions: {
    path: string;
  };
  schemas?: {
    path: string;
    output: string;
    ts_output?: string;
  };
  auth?: AuthConfig;
}

interface RawConfig {
  project?: {
    name?: string;
    url?: string;
  };
  functions?: {
    path?: string;
  };
  schemas?: {
    path?: string;
    output?: string;
    ts_output?: string;
  };
  auth?: {
    password?: boolean;
    magic_link?: boolean;
    email_verification?: boolean;
    password_reset?: boolean;
  };
}

export async function loadConfig(cwd: string): Promise<AizuConfig> {
  const configPath = resolve(cwd, "aizu.toml");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(`Could not read aizu.toml in ${cwd}`);
  }

  const parsed = parse(raw) as RawConfig;

  if (!parsed.project?.name) {
    throw new Error("aizu.toml: project.name is required");
  }
  if (!parsed.project?.url) {
    throw new Error("aizu.toml: project.url is required");
  }
  if (!parsed.functions?.path) {
    throw new Error("aizu.toml: functions.path is required");
  }

  const functionsPath = resolve(cwd, parsed.functions.path);

  const config: AizuConfig = {
    project: {
      name: parsed.project.name,
      url: parsed.project.url.replace(/\/+$/, ""),
    },
    functions: {
      path: functionsPath,
    },
  };

  if (parsed.schemas) {
    config.schemas = {
      path: resolve(functionsPath, parsed.schemas.path ?? "schemas/"),
      output: resolve(functionsPath, parsed.schemas.output ?? "src/generated/"),
      ts_output: parsed.schemas.ts_output
        ? resolve(cwd, parsed.schemas.ts_output)
        : undefined,
    };
  }

  if (parsed.auth) {
    const password = parsed.auth.password ?? false;
    config.auth = {
      password,
      magic_link: parsed.auth.magic_link ?? false,
      email_verification: parsed.auth.email_verification ?? false,
      password_reset: parsed.auth.password_reset ?? password,
    };
  }

  return config;
}
