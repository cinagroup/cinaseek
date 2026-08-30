// Validates the generated connector `.gadget` archives without starting workerd. This catches
// malformed archive metadata, stale sidecars, missing bindings, and syntax errors in the embedded
// client/server source before the templates reach a deployment.

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import * as Y from "yjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const sourceDir = join(packageRoot, "connector-blueprints");
const outputDir = join(packageRoot, "format-blueprints");
const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;

if (process.env.FORMAT_BLUEPRINTS_DIR) {
  console.log("Skipped connector blueprint validation for FORMAT_BLUEPRINTS_DIR override.");
  process.exit(0);
}

const manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8"));

for (const entry of manifest) {
  const archivePath = join(outputDir, `${entry.name}.gadget`);
  const sidecarPath = join(outputDir, `${entry.name}.json`);
  const [archive, sidecarSource] = await Promise.all([
    readFile(archivePath),
    readFile(sidecarPath, "utf8"),
  ]);
  const { metadata, content } = parseArchive(archive, entry.name);
  const sidecar = JSON.parse(sidecarSource);

  expect(sidecar.blueprintId === entry.blueprintId, entry, "sidecar blueprintId is stale");
  expect(sidecar.revision === entry.revision, entry, "sidecar revision is stale");
  expect(sidecar.output?.id === "integration", entry, "sidecar output group must be integration");
  expect(metadata.version === entry.revision, entry, "archive version is stale");

  const bindings = Object.entries(metadata.bindings ?? {});
  expect(bindings.length === 1, entry, "archive must declare exactly one connector binding");
  const [bindingName, binding] = bindings[0] ?? [];
  expect(bindingName === entry.binding.name, entry, "archive binding name is stale");
  expect(binding?.type === "gatekeeper", entry, "archive binding must be a gatekeeper");
  expect(/^[a-z][a-z0-9_]*$/.test(entry.binding.gatekeeperName), entry,
      "gatekeeper name must be the canonical vendor id used by a GATEKEEPER_* binding");
  expect(binding?.gatekeeperName === entry.binding.gatekeeperName, entry,
      "archive gatekeeper name is stale");
  expect(binding?.typeUrlPattern === entry.binding.typeUrlPattern, entry,
      "archive resource type pattern is stale");

  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, gunzipSync(content));
  const files = doc.getMap();
  const serverSource = readTextFile(files, "server.js", entry);
  const clientSource = readTextFile(files, "client.js", entry);
  readTextFile(files, "README.md", entry);

  expect(!serverSource.includes("__CONNECTOR_CONFIG__"), entry,
      "server configuration marker was not replaced");
  expect(serverSource.includes("export class ExportHandler"), entry,
      "server is missing the export handler");
  expect(clientSource.includes("@media print"), entry, "client is missing its print layout");

  await Promise.all([
    parseJavaScript(serverSource, `${entry.name}/server.js`),
    parseJavaScript(clientSource, `${entry.name}/client.js`),
  ]);
}

console.log(`Connector blueprints validated (${manifest.length} archives).`);

function parseArchive(bytes, label) {
  expect(bytes.byteLength >= PREFIX_BYTES, { name: label }, "archive is too short");
  expect(bytes.readBigUInt64BE(0) === MAGIC, { name: label }, "archive magic is invalid");
  expect(bytes.readUInt32BE(8) === VERSION, { name: label }, "archive version is unsupported");
  const metadataLength = bytes.readUInt32BE(12);
  const contentLength = Number(bytes.readBigUInt64BE(16));
  const metadataEnd = PREFIX_BYTES + metadataLength;
  expect(metadataEnd <= bytes.byteLength, { name: label }, "archive metadata is truncated");
  const content = bytes.subarray(metadataEnd);
  expect(content.byteLength === contentLength, { name: label },
      "archive content length does not match its prefix");
  return {
    metadata: JSON.parse(bytes.subarray(PREFIX_BYTES, metadataEnd).toString("utf8")),
    content,
  };
}

function readTextFile(files, name, entry) {
  const value = files.get(name);
  expect(value instanceof Y.Text, entry, `${name} is missing from the archive`);
  const source = value.toString();
  expect(source.trim().length > 0, entry, `${name} is empty`);
  return source;
}

async function parseJavaScript(source, sourcefile) {
  await transform(source, { loader: "js", format: "esm", target: "es2022", sourcefile });
}

function expect(condition, entry, message) {
  if (!condition) throw new Error(`${entry.name}: ${message}`);
}
