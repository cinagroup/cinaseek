// Deterministically builds the official connector template sources into ordinary `.gadget`
// archives consumed by build-format-blueprints.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const sourceDir = join(packageRoot, "connector-blueprints");
const outputDir = join(packageRoot, "format-blueprints");

// FORMAT_BLUEPRINTS_DIR replaces the repository defaults. Never inject CinaSeek's connector
// templates into a deployment-owned directory outside this package.
if (process.env.FORMAT_BLUEPRINTS_DIR) {
  console.log("Skipped connector blueprint generation for FORMAT_BLUEPRINTS_DIR override.");
  process.exit(0);
}

const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
const CREATED = "2026-08-30T00:00:00.000Z";
const AUTHOR = { type: "user", name: "CinaSeek", id: "templates@cinaseek.ai" };
const OUTPUT_ICONS = new Set([
  "fileText", "gridNine", "presentation", "appWindow", "flowArrow",
  "kanban", "chartBar", "table", "notebook", "listChecks",
]);

const [manifestSource, clientSource, serverTemplate] = await Promise.all([
  readFile(join(sourceDir, "manifest.json"), "utf8"),
  readFile(join(sourceDir, "client.js"), "utf8"),
  readFile(join(sourceDir, "server.js"), "utf8"),
]);
const manifest = JSON.parse(manifestSource);
const marker = "__CONNECTOR_CONFIG__";
if (serverTemplate.split(marker).length !== 2) {
  throw new Error(`connector-blueprints/server.js must contain exactly one ${marker} marker`);
}

const seenNames = new Set();
const seenIds = new Set();
let changed = 0;
let totalBytes = 0;

for (const entry of manifest) {
  validateEntry(entry);
  if (seenNames.has(entry.name)) throw new Error(`Duplicate connector blueprint name: ${entry.name}`);
  if (seenIds.has(entry.blueprintId)) throw new Error(`Duplicate connector blueprint id: ${entry.blueprintId}`);
  seenNames.add(entry.name);
  seenIds.add(entry.blueprintId);

  const config = {
    blueprintId: entry.blueprintId,
    connector: entry.connector,
    title: entry.title,
    description: entry.description,
    resourceName: entry.resourceName,
    searchPlaceholder: entry.searchPlaceholder,
    accent: entry.accent,
    binding: entry.binding,
  };
  const serverSource = serverTemplate.replace(marker, JSON.stringify(config, null, 2));
  const readme = `# ${entry.title}\n\n${entry.description}\n\n` +
    `Required binding: \`${entry.binding.name}\` (${entry.binding.title}).\n\n` +
    `This archive is generated from \`connector-blueprints/\`; edit the source rather than ` +
    `the binary archive.\n`;

  const doc = new Y.Doc();
  // Yjs normally chooses a random client id, which would make identical source produce different
  // archive bytes on every build. Assign a stable non-zero id before the first mutation.
  doc.clientID = Number.parseInt(hash(Buffer.from(entry.blueprintId)).slice(0, 8), 16) || 1;
  const files = doc.getMap();
  for (const [name, content] of [["server.js", serverSource], ["client.js", clientSource], ["README.md", readme]]) {
    const text = new Y.Text();
    text.insert(0, content);
    files.set(name, text);
  }
  const compressed = gzipSync(Y.encodeStateAsUpdateV2(doc), { level: 9 });
  const metadata = {
    title: entry.title,
    description: entry.description,
    author: AUTHOR,
    created: CREATED,
    version: entry.revision,
    lastUpdated: CREATED,
    bindings: {
      [entry.binding.name]: {
        title: entry.binding.title,
        description: entry.binding.description,
        type: "gatekeeper",
        gatekeeperName: entry.binding.gatekeeperName,
        typeUrlPattern: entry.binding.typeUrlPattern,
      },
    },
  };
  const archive = serializeArchive(metadata, compressed);
  const sidecar = `${JSON.stringify({
    blueprintId: entry.blueprintId,
    title: entry.title,
    description: entry.description,
    output: {
      id: "integration",
      noun: "Integration App",
      plural: "Integration Apps",
      icon: entry.icon,
    },
    author: AUTHOR,
    revision: entry.revision,
  }, null, 2)}\n`;

  changed += await writeIfChanged(join(outputDir, `${entry.name}.gadget`), archive);
  changed += await writeIfChanged(join(outputDir, `${entry.name}.json`), sidecar);
  totalBytes += archive.byteLength;
}

console.log(`Connector blueprints up-to-date (${manifest.length}, ` +
  `${Math.round(totalBytes / 1024)} KiB${changed ? `, ${changed} file(s) written` : ""}).`);

function validateEntry(entry) {
  const required = ["name", "blueprintId", "connector", "title", "description", "resourceName", "searchPlaceholder", "accent", "icon"];
  for (const key of required) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) {
      throw new Error(`Connector blueprint ${entry.name || "(unnamed)"}: ${key} is required`);
    }
  }
  if (!/^[a-z0-9.-]+$/.test(entry.name) || !/^[a-zA-Z0-9._-]+$/.test(entry.blueprintId)) {
    throw new Error(`Invalid connector blueprint name/id: ${entry.name} / ${entry.blueprintId}`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(entry.accent)) throw new Error(`${entry.name}: invalid accent`);
  if (!OUTPUT_ICONS.has(entry.icon)) throw new Error(`${entry.name}: unknown output icon ${entry.icon}`);
  if (!Number.isInteger(entry.revision) || entry.revision < 1) throw new Error(`${entry.name}: invalid revision`);
  for (const key of ["name", "gatekeeperName", "typeUrlPattern", "title", "description"]) {
    if (typeof entry.binding?.[key] !== "string" || !entry.binding[key].trim()) {
      throw new Error(`${entry.name}: binding.${key} is required`);
    }
  }
}

function serializeArchive(metadata, content) {
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const archive = Buffer.alloc(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  archive.writeBigUInt64BE(MAGIC, 0);
  archive.writeUInt32BE(VERSION, 8);
  archive.writeUInt32BE(metadataBytes.byteLength, 12);
  archive.writeBigUInt64BE(BigInt(content.byteLength), 16);
  metadataBytes.copy(archive, PREFIX_BYTES);
  Buffer.from(content).copy(archive, PREFIX_BYTES + metadataBytes.byteLength);
  return archive;
}

async function writeIfChanged(path, content) {
  const bytes = Buffer.from(content);
  let existing;
  try { existing = await readFile(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && hash(existing) === hash(bytes)) return 0;
  await writeFile(path, bytes);
  return 1;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
