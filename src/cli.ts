import { loadConfig } from "./config.js";
import { deploy } from "./commands/deploy.js";
import { init } from "./commands/init.js";
import * as log from "./logger.js";

const USAGE = `
Usage: aizu <command> [options]

Commands:
  init      Initialize a new Aizu project
  deploy    Build and deploy functions to Aizu

Options:
  --name <name>  Project name (init only, defaults to directory name)
  --key <key>    API key (default: AIZU_DEPLOY_KEY env var)
  --verbose      Show detailed output
  --help         Show this help message
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  const command = args[0];
  const flags = parseFlags(args.slice(1));

  if (command === "init") {
    await init(process.cwd(), {
      name: flags.name,
      verbose: flags.verbose === "true",
    });
  } else if (command === "deploy") {
    const apiKey =
      flags.key ?? process.env.AIZU_DEPLOY_KEY;

    if (!apiKey) {
      log.error(
        "Missing API key. Set AIZU_DEPLOY_KEY env var or pass --key <key>"
      );
      process.exit(1);
    }

    const config = await loadConfig(process.cwd());
    log.info(`Deploying ${config.project.name} to ${config.project.url}`);

    await deploy(config, {
      apiKey,
      verbose: flags.verbose === "true",
    });
  } else {
    log.error(`Unknown command: ${command}`);
    console.log(USAGE.trim());
    process.exit(1);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--verbose" || arg === "-v") {
      flags.verbose = "true";
    } else if ((arg === "--key" || arg === "-k") && i + 1 < args.length) {
      flags.key = args[++i];
    } else if ((arg === "--name" || arg === "-n") && i + 1 < args.length) {
      flags.name = args[++i];
    }
  }
  return flags;
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
