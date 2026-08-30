import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeTextSymlinkAssets } from "./build-validated-worker.mjs";

test("materializes Windows Git symlink placeholders only in generated output", () => {
  const packageDir = mkdtempSync(join(tmpdir(), "validated-worker-"));
  try {
    const sourceDir = join(packageDir, "src");
    const outputDir = join(packageDir, ".wrangler", "validate");
    const outputSourceDir = join(outputDir, "src");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outputSourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "types.d.ts"), "export interface Session {}\n");
    writeFileSync(join(sourceDir, "types.txt"), "types.d.ts");
    writeFileSync(join(sourceDir, "description.txt"), "ordinary text\n");
    writeFileSync(join(outputSourceDir, "types.txt"), "types.d.ts");
    writeFileSync(join(outputSourceDir, "description.txt"), "ordinary text\n");

    assert.equal(materializeTextSymlinkAssets(packageDir, outputDir), 1);
    assert.equal(
        readFileSync(join(outputSourceDir, "types.txt"), "utf8"),
        "export interface Session {}\n",
    );
    assert.equal(
        readFileSync(join(outputSourceDir, "description.txt"), "utf8"),
        "ordinary text\n",
    );
    assert.equal(readFileSync(join(sourceDir, "types.txt"), "utf8"), "types.d.ts");
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
});
