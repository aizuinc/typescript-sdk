import { defineConfig } from "tsup";

export default defineConfig([
  // CLI binary
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node18",
    clean: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  // SDK (client + react)
  {
    entry: ["src/sdk/index.ts", "src/sdk/react.tsx"],
    format: ["cjs", "esm"],
    dts: true,
    target: "es2020",
    external: ["react"],
  },
]);
