import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 1_000_000;
const MAX_TOTAL_ROWS = 5_000_000;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;

/** One decoded row plus its non-sensitive source basename. */
export interface ProductAnalyticsSourceRow {
  /** Basename of the finalized Parquet object. */
  source: string;
  /** Decoded row value supplied by the Parquet reader. */
  value: unknown;
}

interface ParsedEvent {
  eventId: string;
  eventName: string;
  properties: JsonRecord;
  rowIndex: number;
  source: string;
  value: JsonRecord;
  workspaceId?: string;
}

/** One validation failure that does not expose event payloads or identifiers. */
export interface ProductAnalyticsValidationIssue {
  /** Basename of the Parquet file that contains the invalid row. */
  source: string;
  /** Zero-based row index within the combined input. */
  row: number;
  /** Bounded explanation without provider-authored or row-supplied content. */
  reason: string;
}

/** Privacy-preserving report produced from finalized product-analytics Parquet objects. */
export interface ProductAnalyticsAuditReport {
  /** Version of this JSON report contract. */
  schemaVersion: 1;
  /** Input file and byte totals. */
  files: { count: number; names: string[]; totalBytes: number };
  /** Raw, valid, unique, and duplicate row counts. */
  rows: {
    raw: number;
    valid: number;
    unique: number;
    duplicateCopies: number;
    duplicateEventIds: number;
    conflictingDuplicateEventIds: number;
  };
  /** Per-event counts before and after event-id de-duplication. */
  events: Record<string, { raw: number; unique: number }>;
  /** Stable Dynamic Worker identity groups with raw identifiers replaced by fingerprints. */
  dynamicWorkers: {
    requests: number;
    workspaces: number;
    workpieces: number;
    workerIds: number;
    executionVersions: number;
    mainlineWorkerIds: number;
    previewWorkerIds: number;
    observations: Array<{
      workspace: string;
      workpiece: string;
      mode: "mainline" | "preview";
      worker: string;
      executionVersion: string;
      chat?: string;
      requests: number;
    }>;
  };
  /** Fingerprinted duplicate ids, including whether their payloads disagree. */
  duplicates: Array<{ event: string; copies: number; conflicting: boolean }>;
  /** True only when every row and every Dynamic Worker event passed validation. */
  valid: boolean;
  /** Bounded validation failures. */
  issues: ProductAnalyticsValidationIssue[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalized(value));
}

function parseProperties(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseEvent(row: ProductAnalyticsSourceRow, index: number):
    { event: ParsedEvent } | { issue: ProductAnalyticsValidationIssue } {
  const issue = (reason: string) => ({ issue: { source: row.source, row: index, reason } });
  if (!isRecord(row.value)) return issue("row is not an object");
  if (typeof row.value.event_id !== "string" || !EVENT_ID.test(row.value.event_id)) {
    return issue("event_id is not a supported UUID");
  }
  if (typeof row.value.event_name !== "string" || row.value.event_name.length === 0 ||
      row.value.event_name.length > 128) {
    return issue("event_name is missing or exceeds 128 characters");
  }
  const timestampValue = row.value.event_ts;
  const timestamp = timestampValue instanceof Date
    ? timestampValue
    : typeof timestampValue === "string" ? new Date(timestampValue) : undefined;
  if (!timestamp || !Number.isFinite(timestamp.valueOf())) {
    return issue("event_ts is not a valid timestamp");
  }
  const properties = parseProperties(row.value.properties);
  if (!properties) return issue("properties is not a JSON object");
  if (row.value.gadget_id !== undefined && row.value.gadget_id !== null &&
      (typeof row.value.gadget_id !== "string" || row.value.gadget_id.length === 0 ||
        row.value.gadget_id.length > 1024)) {
    return issue("gadget_id is not a string");
  }
  return {
    event: {
      eventId: row.value.event_id,
      eventName: row.value.event_name,
      properties,
      rowIndex: index,
      source: row.source,
      value: row.value,
      workspaceId: typeof row.value.gadget_id === "string" ? row.value.gadget_id : undefined,
    },
  };
}

function addCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Analyze already-decoded rows. Exported separately so validation and grouping stay unit-testable. */
export function analyzeProductAnalyticsRows(
  rows: ProductAnalyticsSourceRow[],
  files: ProductAnalyticsAuditReport["files"],
): ProductAnalyticsAuditReport {
  const issues: ProductAnalyticsValidationIssue[] = [];
  const validEvents: ParsedEvent[] = [];
  const rawEventCounts = new Map<string, number>();
  rows.forEach((row, index) => {
    const parsed = parseEvent(row, index);
    if ("issue" in parsed) issues.push(parsed.issue);
    else {
      validEvents.push(parsed.event);
      addCount(rawEventCounts, parsed.event.eventName);
    }
  });

  const byId = new Map<string, {
    first: ParsedEvent;
    canonical: string;
    copies: number;
    conflicting: boolean;
  }>();
  for (const event of validEvents) {
    const existing = byId.get(event.eventId);
    const payload = canonical(event.value);
    if (!existing) {
      byId.set(event.eventId, { first: event, canonical: payload, copies: 1, conflicting: false });
    } else {
      existing.copies++;
      if (existing.canonical !== payload) existing.conflicting = true;
    }
  }
  const uniqueEvents = [...byId.values()].map(entry => entry.first);
  const uniqueEventCounts = new Map<string, number>();
  for (const event of uniqueEvents) addCount(uniqueEventCounts, event.eventName);

  const observationCounts = new Map<string, {
    workspace: string;
    workpiece: string;
    mode: "mainline" | "preview";
    worker: string;
    executionVersion: string;
    chat?: string;
    requests: number;
  }>();
  const workspaceIds = new Set<string>();
  const workpieceIds = new Set<string>();
  const workerIds = new Set<string>();
  const executionVersions = new Set<string>();
  const mainlineWorkerIds = new Set<string>();
  const previewWorkerIds = new Set<string>();
  let dynamicRequests = 0;

  for (const event of uniqueEvents) {
    if (event.eventName !== "dynamic_worker_requested") continue;
    const props = event.properties;
    const workerId = props.worker_id;
    const workpieceId = props.workpiece_id;
    const executionVersion = props.execution_version;
    const mode = props.mode;
    const chatId = props.chat_id;
    if (!event.workspaceId) {
      issues.push({ source: event.source, row: event.rowIndex,
        reason: "dynamic_worker_requested is missing gadget_id" });
      continue;
    }
    if (typeof workerId !== "string" || workerId.length === 0 || workerId.length > 4096 ||
        typeof workpieceId !== "number" || !Number.isSafeInteger(workpieceId) || workpieceId < 0 ||
        typeof executionVersion !== "string" || executionVersion.length === 0 ||
        executionVersion.length > 4096 ||
        (mode !== "mainline" && mode !== "preview") ||
        (chatId !== undefined &&
          (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId < 0)) ||
        (mode === "preview" && chatId === undefined) ||
        (mode === "mainline" && chatId !== undefined)) {
      issues.push({ source: event.source, row: event.rowIndex,
        reason: "dynamic_worker_requested has invalid identity properties" });
      continue;
    }
    dynamicRequests++;
    const workspace = fingerprint(event.workspaceId);
    const workpiece = fingerprint(String(workpieceId));
    const worker = fingerprint(workerId);
    const version = fingerprint(executionVersion);
    const chat = chatId === undefined ? undefined : fingerprint(String(chatId));
    const key = [workspace, workpiece, mode, worker, version, chat ?? ""].join("|");
    const existing = observationCounts.get(key);
    if (existing) existing.requests++;
    else observationCounts.set(key, {
      workspace,
      workpiece,
      mode,
      worker,
      executionVersion: version,
      ...(chat === undefined ? {} : { chat }),
      requests: 1,
    });
    workspaceIds.add(event.workspaceId);
    workpieceIds.add(String(workpieceId));
    workerIds.add(workerId);
    executionVersions.add(executionVersion);
    (mode === "mainline" ? mainlineWorkerIds : previewWorkerIds).add(workerId);
  }

  const duplicates = [...byId.entries()]
    .filter(([, entry]) => entry.copies > 1)
    .map(([eventId, entry]) => ({
      event: fingerprint(eventId),
      copies: entry.copies,
      conflicting: entry.conflicting,
    }))
    .toSorted((left, right) => left.event.localeCompare(right.event));
  const eventNames = new Set([...rawEventCounts.keys(), ...uniqueEventCounts.keys()]);
  const events = Object.fromEntries([...eventNames].toSorted().map(name => [name, {
    raw: rawEventCounts.get(name) ?? 0,
    unique: uniqueEventCounts.get(name) ?? 0,
  }]));

  return {
    schemaVersion: 1,
    files,
    rows: {
      raw: rows.length,
      valid: validEvents.length,
      unique: uniqueEvents.length,
      duplicateCopies: validEvents.length - uniqueEvents.length,
      duplicateEventIds: duplicates.length,
      conflictingDuplicateEventIds: duplicates.filter(entry => entry.conflicting).length,
    },
    events,
    dynamicWorkers: {
      requests: dynamicRequests,
      workspaces: workspaceIds.size,
      workpieces: workpieceIds.size,
      workerIds: workerIds.size,
      executionVersions: executionVersions.size,
      mainlineWorkerIds: mainlineWorkerIds.size,
      previewWorkerIds: previewWorkerIds.size,
      observations: [...observationCounts.values()].toSorted((left, right) =>
        [left.workspace, left.workpiece, left.mode, left.worker, left.executionVersion, left.chat ?? ""]
          .join("|").localeCompare(
            [right.workspace, right.workpiece, right.mode, right.worker, right.executionVersion,
              right.chat ?? ""].join("|"),
          )),
    },
    duplicates,
    valid: issues.length === 0 && duplicates.every(entry => !entry.conflicting),
    issues,
  };
}

async function inputFiles(inputs: string[]): Promise<Array<{ path: string; size: number }>> {
  const paths: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`symbolic links are not accepted: ${basename(path)}`);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && extname(entry.name).toLowerCase() === ".parquet") {
          paths.push(resolve(path, entry.name));
        }
      }
    } else if (info.isFile() && extname(path).toLowerCase() === ".parquet") paths.push(path);
    else throw new Error(`input is not a Parquet file or directory: ${basename(path)}`);
  }
  const uniquePaths = [...new Set(paths)].toSorted();
  if (uniquePaths.length === 0) throw new Error("no Parquet files found");
  if (uniquePaths.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} Parquet files selected`);
  const result: Array<{ path: string; size: number }> = [];
  let totalBytes = 0;
  for (const path of uniquePaths) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe input file: ${basename(path)}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`Parquet file exceeds 64 MiB: ${basename(path)}`);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Parquet inputs exceed 512 MiB total");
    result.push({ path, size: info.size });
  }
  return result;
}

/** Read finalized local Parquet objects and return a privacy-preserving audit report. */
export async function auditProductAnalyticsParquet(inputs: string[]): Promise<ProductAnalyticsAuditReport> {
  const files = await inputFiles(inputs);
  const rows: ProductAnalyticsSourceRow[] = [];
  let totalRows = 0n;
  for (const file of files) {
    const buffer = await asyncBufferFromFile(file.path);
    const metadata = await parquetMetadataAsync(buffer);
    if (metadata.num_rows > BigInt(MAX_ROWS_PER_FILE)) {
      throw new Error(`Parquet file exceeds 1,000,000 rows: ${basename(file.path)}`);
    }
    totalRows += metadata.num_rows;
    if (totalRows > BigInt(MAX_TOTAL_ROWS)) throw new Error("Parquet inputs exceed 5,000,000 rows total");
    const decoded = await parquetReadObjects({
      file: buffer,
      compressors,
      columns: ["event_id", "event_ts", "event_name", "user_id", "gadget_id", "properties"],
    });
    rows.push(...decoded.map(value => ({ source: basename(file.path), value })));
  }
  return analyzeProductAnalyticsRows(rows, {
    count: files.length,
    names: files.map(file => basename(file.path)),
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  });
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0 || inputs.includes("--help")) {
    console.error("Usage: node scripts/cost-control/product-analytics-parquet.ts <file-or-directory> [...]");
    process.exitCode = inputs.includes("--help") ? 0 : 2;
    return;
  }
  const report = await auditProductAnalyticsParquet(inputs);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`Product analytics Parquet audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
