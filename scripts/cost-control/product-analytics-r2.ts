import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AwsClient } from "aws4fetch";

import {
  auditProductAnalyticsParquet,
  PRODUCT_ANALYTICS_PARQUET_LIMITS,
  type ProductAnalyticsAuditReport,
} from "./product-analytics-parquet.ts";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Reuse the repository's XML parser; regex matching cannot detect a truncated response.
const { JSDOM } = createRequire(import.meta.url)("jsdom");

interface SignedR2Client {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Configuration for one closed-day, bucket-scoped R2 audit; credentials must not be logged. */
export interface ProductAnalyticsR2AuditConfig {
  /** Cloudflare account identifier used to derive the fixed R2 S3 endpoint. */
  accountId: string;
  /** Product-analytics bucket selected when the Object Read only credential was created. */
  bucket: string;
  /** Closed UTC date whose immutable Pipeline objects will be audited. */
  day: string;
  /** R2 S3 Access Key ID from the bucket-scoped Object Read only credential. */
  accessKeyId: string;
  /** R2 S3 Secret Access Key from the bucket-scoped Object Read only credential. */
  secretAccessKey: string;
}

/** Privacy-preserving acquisition metadata plus the existing Parquet audit report. */
export interface ProductAnalyticsR2AuditReport {
  /** Version of the acquisition report contract. */
  schemaVersion: 1;
  /** Closed UTC partition that was listed and downloaded. */
  day: string;
  /** Number and total bytes of Parquet objects fetched through read-only S3 operations. */
  objects: { count: number; totalBytes: number; nonParquetObjects: number };
  /** Content-level privacy and identity audit. */
  audit: ProductAnalyticsAuditReport;
}

interface R2Object {
  key: string;
  size: number;
}

interface ListPage {
  objects: R2Object[];
  nonParquetObjects: number;
  nextContinuationToken?: string;
}

interface ProductAnalyticsR2AuditDependencies {
  client?: SignedR2Client;
  audit?: typeof auditProductAnalyticsParquet;
  now?: Date;
  tempRoot?: string;
}

// The Node tooling project has no browser DOM globals. This is the small, read-only XML
// element surface consumed from jsdom, not an RPC or provider-response assertion.
interface XmlElement {
  readonly localName: string;
  readonly children: ArrayLike<XmlElement>;
  readonly textContent: string | null;
}

function xmlText(parent: XmlElement, name: string): string | undefined {
  const matches = Array.from(parent.children).filter(child => child.localName === name);
  if (matches.length > 1 || matches[0]?.children.length) {
    throw new Error("R2 list response contains duplicate or nested scalar fields");
  }
  return matches[0]?.textContent ?? undefined;
}

function parseListPage(xml: string, prefix: string, seenKeys: Set<string>): ListPage {
  if (xml.includes("<!DOCTYPE")) throw new Error("R2 list response must not contain a DTD");
  let view;
  try {
    view = new JSDOM(xml, { contentType: "application/xml" }).window;
  } catch {
    // XML diagnostics may quote provider-authored object keys; never forward those diagnostics.
    throw new Error("R2 list response is not complete, well-formed XML");
  }
  try {
    const root: XmlElement = view.document.documentElement;
    if (root.localName !== "ListBucketResult") throw new Error("R2 list response has an unexpected root");
    return parseListResult(root, prefix, seenKeys);
  } finally {
    view.close();
  }
}

function parseListResult(root: XmlElement, prefix: string, seenKeys: Set<string>): ListPage {
  const truncated = xmlText(root, "IsTruncated");
  if (truncated !== "true" && truncated !== "false") {
    throw new Error("R2 list response omitted a valid pagination state");
  }
  if (xmlText(root, "EncodingType") !== "url") {
    throw new Error("R2 list response omitted the requested URL encoding");
  }
  const children = Array.from(root.children);
  const entries = children.filter(child => child.localName === "Contents");
  const keyCount = xmlText(root, "KeyCount");
  if (keyCount === undefined || !/^\d+$/.test(keyCount) || Number(keyCount) !== entries.length ||
      children.some(child => child.localName === "CommonPrefixes")) {
    throw new Error("R2 list response has incomplete object coverage");
  }
  const objects: R2Object[] = [];
  let nonParquetObjects = 0;
  for (const entry of entries) {
    const encodedKey = xmlText(entry, "Key");
    const sizeText = xmlText(entry, "Size");
    if (encodedKey === undefined || sizeText === undefined || !/^\d+$/.test(sizeText)) {
      throw new Error("R2 list response contains an invalid object entry");
    }
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      throw new Error("R2 list response contains an invalid encoded key");
    }
    const size = Number(sizeText);
    if (!key.startsWith(prefix) || !Number.isSafeInteger(size) || size < 0 ||
        key.split("/").some(part => part === "." || part === "..")) {
      throw new Error("R2 list response escaped the requested partition or byte bounds");
    }
    if (seenKeys.has(key)) throw new Error("R2 list response repeated an object key");
    seenKeys.add(key);
    if (!key.toLowerCase().endsWith(".parquet")) {
      nonParquetObjects++;
      continue;
    }
    objects.push({ key, size });
  }
  const token = xmlText(root, "NextContinuationToken");
  if (truncated === "false") return { objects, nonParquetObjects };
  if (!token) throw new Error("R2 list response omitted its continuation token");
  return { objects, nonParquetObjects, nextContinuationToken: token };
}

function closedDay(day: string, now: Date): { day: string; prefix: string } {
  const match = DAY.exec(day);
  if (!match || !Number.isFinite(now.valueOf())) throw new Error("--day must be a valid closed UTC date");
  const normalized = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(normalized.valueOf()) || normalized.toISOString().slice(0, 10) !== day) {
    throw new Error("--day must be a valid closed UTC date");
  }
  const currentDay = now.toISOString().slice(0, 10);
  if (day >= currentDay) throw new Error("--day must be earlier than the current UTC date");
  return {
    day,
    prefix: `analytics/events/year=${match[1]}/month=${match[2]}/day=${match[3]}/`,
  };
}

function objectUrl(endpoint: string, bucket: string, key?: string): URL {
  const bucketPath = encodeURIComponent(bucket);
  const keyPath = key?.split("/").map(part => encodeURIComponent(part)).join("/");
  return new URL(`${endpoint}/${bucketPath}${keyPath ? `/${keyPath}` : ""}`);
}

async function listObjects(
  client: SignedR2Client,
  endpoint: string,
  bucket: string,
  prefix: string,
): Promise<{ objects: R2Object[]; nonParquetObjects: number }> {
  const objects: R2Object[] = [];
  let nonParquetObjects = 0;
  let continuationToken: string | undefined;
  const seenContinuationTokens = new Set<string>();
  const seenKeys = new Set<string>();
  let pages = 0;
  do {
    if (++pages > PRODUCT_ANALYTICS_PARQUET_LIMITS.maxFiles + 1) {
      throw new Error("R2 list response exceeded the pagination bound");
    }
    const url = objectUrl(endpoint, bucket);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("encoding-type", "url");
    url.searchParams.set("max-keys", String(PRODUCT_ANALYTICS_PARQUET_LIMITS.maxFiles));
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    const response = await client.fetch(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`R2 list failed with status ${response.status}`);
    const page = parseListPage(await response.text(), prefix, seenKeys);
    objects.push(...page.objects);
    nonParquetObjects += page.nonParquetObjects;
    if (objects.length + nonParquetObjects > PRODUCT_ANALYTICS_PARQUET_LIMITS.maxFiles) {
      throw new Error(
        `R2 partition contains more than ${PRODUCT_ANALYTICS_PARQUET_LIMITS.maxFiles} objects`,
      );
    }
    continuationToken = page.nextContinuationToken;
    if (continuationToken && seenContinuationTokens.has(continuationToken)) {
      throw new Error("R2 list response repeated its continuation token");
    }
    if (continuationToken) seenContinuationTokens.add(continuationToken);
  } while (continuationToken);
  if (objects.length === 0) throw new Error("R2 partition contains no Parquet objects");
  return { objects, nonParquetObjects };
}

/** List and GET one closed Pipeline partition, audit it locally, then remove every temp file. */
export async function auditProductAnalyticsR2Day(
  config: ProductAnalyticsR2AuditConfig,
  dependencies: ProductAnalyticsR2AuditDependencies = {},
): Promise<ProductAnalyticsR2AuditReport> {
  if (!ACCOUNT_ID.test(config.accountId)) throw new Error("invalid Cloudflare account ID");
  if (!BUCKET_NAME.test(config.bucket)) throw new Error("invalid R2 bucket name");
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("R2 read credentials are required");
  const partition = closedDay(config.day, dependencies.now ?? new Date());
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  const client = dependencies.client ?? new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const listed = await listObjects(client, endpoint, config.bucket, partition.prefix);
  let totalBytes = 0;
  for (const object of listed.objects) {
    if (object.size > PRODUCT_ANALYTICS_PARQUET_LIMITS.maxFileBytes) {
      throw new Error("R2 Parquet object exceeds 64 MiB");
    }
    totalBytes += object.size;
    if (totalBytes > PRODUCT_ANALYTICS_PARQUET_LIMITS.maxTotalBytes) {
      throw new Error("R2 Parquet partition exceeds 512 MiB total");
    }
  }

  const tempDirectory = await mkdtemp(join(dependencies.tempRoot ?? tmpdir(), "cinaseek-r2-audit-"));
  try {
    const paths: string[] = [];
    for (const [index, object] of listed.objects.entries()) {
      const response = await client.fetch(objectUrl(endpoint, config.bucket, object.key), {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`R2 object ${index + 1} GET failed with status ${response.status}`);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength !== object.size) {
        throw new Error(`R2 object ${index + 1} size changed during the audit`);
      }
      const path = join(tempDirectory, `object-${String(index + 1).padStart(4, "0")}.parquet`);
      await writeFile(path, body, { flag: "wx" });
      paths.push(path);
    }
    const audit = await (dependencies.audit ?? auditProductAnalyticsParquet)(paths);
    return {
      schemaVersion: 1,
      day: partition.day,
      objects: {
        count: listed.objects.length,
        totalBytes,
        nonParquetObjects: listed.nonParquetObjects,
      },
      audit,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv: string[]): { day?: string; help: boolean } {
  let day: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--day") day = argv[++index];
    else if (argument === "--help") help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return { day, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error("Usage: pnpm audit:product-analytics:r2 -- --day YYYY-MM-DD");
    return;
  }
  if (!args.day) throw new Error("--day YYYY-MM-DD is required");
  const report = await auditProductAnalyticsR2Day({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    bucket: requiredEnvironment("CINASEEK_PRODUCT_ANALYTICS_R2_BUCKET"),
    day: args.day,
    accessKeyId: requiredEnvironment("CINASEEK_PRODUCT_ANALYTICS_R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("CINASEEK_PRODUCT_ANALYTICS_R2_SECRET_ACCESS_KEY"),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.audit.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `Product analytics R2 audit failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
