import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
const viteCli = resolve(packageDirectory, "node_modules", "vite", "bin", "vite.js");

execFileSync(
  process.execPath,
  [viteCli, "build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])],
  { cwd: packageDirectory, stdio: "inherit" },
);
