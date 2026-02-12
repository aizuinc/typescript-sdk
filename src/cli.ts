import { loadConfig } from "./config.js";
import { deploy } from "./commands/deploy.js";
import { init } from "./commands/init.js";
import * as pkg from "./commands/pkg.js";
import * as log from "./logger.js";

const USAGE = `
Usage: aizu <command> [options]

Commands:
  init                Initialize a new Aizu project
  deploy              Build and deploy functions to Aizu

  add <name>          Add a package dependency
  remove <name>       Remove a package dependency
  install             Install all package dependencies
  publish             Publish a package to the registry
  search <query>      Search the registry for packages
  info <name>         Show detailed info about a package
  list                List installed packages
  login               Authenticate with the registry
  register            Register a new registry account

Options:
  --name <name>       Project name (init only)
  --key <key>         API key (default: AIZU_DEPLOY_KEY env var)
  --version <ver>     Version requirement (add only)
  --path <path>       Local package path (add only)
  --git <url>         Git repository URL (add only)
  --branch <branch>   Git branch (add only)
  --tag <tag>         Git tag (add only)
  --registry <url>    Registry URL (login/register only)
  --verbose           Show detailed output
  --help              Show this help message
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  const command = args[0];
  const flags = parseFlags(args.slice(1));

  switch (command) {
    case "init":
      await init(process.cwd(), {
        name: flags.name,
        verbose: flags.verbose === "true",
      });
      break;

    case "deploy": {
      const apiKey = flags.key ?? process.env.AIZU_DEPLOY_KEY;

      if (!apiKey) {
        log.error(
          "Missing API key. Set AIZU_DEPLOY_KEY env var or pass --key <key>",
        );
        process.exit(1);
      }

      const config = await loadConfig(process.cwd());
      log.info(`Deploying ${config.project.name} to ${config.project.url}`);

      await deploy(config, {
        apiKey,
        verbose: flags.verbose === "true",
      });
      break;
    }

    case "add": {
      const name = args[1];
      if (!name || name.startsWith("-")) {
        log.error("Usage: aizu add <package-name> [--version <ver>] [--path <path>] [--git <url>]");
        process.exit(1);
      }
      await pkg.add(process.cwd(), name, {
        version: flags.version,
        path: flags.path,
        git: flags.git,
        branch: flags.branch,
        tag: flags.tag,
      });
      break;
    }

    case "remove": {
      const name = args[1];
      if (!name || name.startsWith("-")) {
        log.error("Usage: aizu remove <package-name>");
        process.exit(1);
      }
      await pkg.remove(process.cwd(), name);
      break;
    }

    case "install":
      await pkg.install(process.cwd());
      break;

    case "publish":
      await pkg.publish(process.cwd());
      break;

    case "search": {
      const query = args[1];
      if (!query) {
        log.error("Usage: aizu search <query>");
        process.exit(1);
      }
      await pkg.search(query);
      break;
    }

    case "info": {
      const name = args[1];
      if (!name) {
        log.error("Usage: aizu info <package-name>");
        process.exit(1);
      }
      await pkg.info(name);
      break;
    }

    case "list":
      await pkg.list(process.cwd());
      break;

    case "login":
      await pkg.login(flags.registry);
      break;

    case "register":
      await pkg.register(flags.registry);
      break;

    default:
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
    } else if (arg === "--version" && i + 1 < args.length) {
      flags.version = args[++i];
    } else if (arg === "--path" && i + 1 < args.length) {
      flags.path = args[++i];
    } else if (arg === "--git" && i + 1 < args.length) {
      flags.git = args[++i];
    } else if (arg === "--branch" && i + 1 < args.length) {
      flags.branch = args[++i];
    } else if (arg === "--tag" && i + 1 < args.length) {
      flags.tag = args[++i];
    } else if (arg === "--registry" && i + 1 < args.length) {
      flags.registry = args[++i];
    }
  }
  return flags;
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
