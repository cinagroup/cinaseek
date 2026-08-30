#!/usr/bin/env node

// Runs capnweb-validate and repairs text assets when Git for Windows checked out a repository
// symlink as a small file containing only its target path. The repair is limited to generated
// output, so the tracked working tree remains untouched.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function visitFiles(directory, callback) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visitFiles(path, callback);
    else callback(path);
  }
}

function resolveTextAssetTarget(packageDir, sourcePath) {
  const sourceInfo = lstatSync(sourcePath);
  const linkTarget = sourceInfo.isSymbolicLink()
    ? readlinkSync(sourcePath)
    : readFileSync(sourcePath, "utf8");
  if (/\r|\n/.test(linkTarget) || linkTarget.length === 0 || linkTarget.length > 512) return null;

  const targetPath = resolve(dirname(sourcePath), linkTarget);
  if (!isWithin(packageDir, targetPath) || !existsSync(targetPath) ||
      !lstatSync(targetPath).isFile()) {
    return null;
  }
  return targetPath;
}

/**
 * Expands Git symlink placeholders in generated text assets.
 *
 * @param {string} packageDir package root containing `src`
 * @param {string} outputDir capnweb-validate output root containing generated `src`
 * @returns {number} number of generated assets materialized
 */
export function materializeTextSymlinkAssets(packageDir, outputDir) {
  const normalizedPackageDir = resolve(packageDir);
  const sourceDir = join(normalizedPackageDir, "src");
  const outputSourceDir = join(resolve(outputDir), "src");
  let count = 0;

  visitFiles(sourceDir, (sourcePath) => {
    if (!sourcePath.endsWith(".txt")) return;
    const targetPath = resolveTextAssetTarget(normalizedPackageDir, sourcePath);
    if (!targetPath) return;

    const outputPath = join(outputSourceDir, relative(sourceDir, sourcePath));
    if (!existsSync(outputPath) || lstatSync(outputPath).isSymbolicLink()) return;
    writeFileSync(outputPath, readFileSync(targetPath));
    count++;
  });

  return count;
}

function main() {
  const [capnwebValidateCli, outputArg = ".wrangler/validate"] = process.argv.slice(2);
  if (!capnwebValidateCli) {
    throw new Error("Usage: build-validated-worker.mjs <capnweb-validate-cli> [output-dir]");
  }

  const packageDir = process.cwd();
  execFileSync(
      process.execPath,
      [resolve(capnwebValidateCli), "build", "--out", outputArg],
      { cwd: packageDir, stdio: "inherit" },
  );
  const count = materializeTextSymlinkAssets(packageDir, resolve(packageDir, outputArg));
  if (count > 0) console.log(`Materialized ${count} generated text symlink asset(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
