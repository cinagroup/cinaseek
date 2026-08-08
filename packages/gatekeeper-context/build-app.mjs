// Build the Context Library SPA into generated single-file HTML for startAppUi().

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
const viteCli = resolve(pkgDir, "node_modules", "vite", "bin", "vite.js");

console.log(
  watch
    ? "watching context library app for changes…"
    : "building context library app single-file bundle…",
);
execFileSync(
  process.execPath,
  [viteCli, "build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])],
  { cwd: pkgDir, stdio: "inherit" },
);
