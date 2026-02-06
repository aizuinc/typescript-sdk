const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

export function info(msg: string) {
  console.log(`${BLUE}info${RESET}  ${msg}`);
}

export function success(msg: string) {
  console.log(`${GREEN}${BOLD}ok${RESET}    ${msg}`);
}

export function warn(msg: string) {
  console.log(`${YELLOW}warn${RESET}  ${msg}`);
}

export function error(msg: string) {
  console.error(`${RED}${BOLD}error${RESET} ${msg}`);
}

export function step(n: number, total: number, msg: string) {
  console.log(`\n${CYAN}[${n}/${total}]${RESET} ${BOLD}${msg}${RESET}`);
}

export function detail(msg: string) {
  console.log(`${DIM}      ${msg}${RESET}`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(msg: string) {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(
      `\r${CYAN}${SPINNER_FRAMES[i % SPINNER_FRAMES.length]}${RESET} ${msg}`
    );
    i++;
  }, 80);

  return {
    stop(finalMsg?: string) {
      clearInterval(id);
      process.stdout.write(`\r\x1b[K`);
      if (finalMsg) success(finalMsg);
    },
    fail(finalMsg?: string) {
      clearInterval(id);
      process.stdout.write(`\r\x1b[K`);
      if (finalMsg) error(finalMsg);
    },
  };
}
