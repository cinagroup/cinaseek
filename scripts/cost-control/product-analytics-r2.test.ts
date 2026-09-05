import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ProductAnalyticsAuditReport } from "./product-analytics-parquet.ts";
import { auditProductAnalyticsR2Day } from "./product-analytics-r2.ts";

const CONFIG = {
  accountId: "7ea8e46d8210bad342fa7595f7935fea",
  bucket: "cinaseek-ai-product-analytics",
  day: "2026-09-03",
  accessKeyId: "read-only-access-key",
  secretAccessKey: "read-only-secret-key",
};

const AUDIT_REPORT = { valid: true } as ProductAnalyticsAuditReport;

function listXml(entries: Array<{ key: string; size: number }>, options: {
  truncated?: boolean;
  token?: string;
} = {}): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<ListBucketResult>",
    "<EncodingType>url</EncodingType>",
    `<KeyCount>${entries.length}</KeyCount>`,
    ...entries.map(entry =>
      `<Contents><Key>${encodeURIComponent(entry.key)}</Key><Size>${entry.size}</Size></Contents>`
    ),
    `<IsTruncated>${options.truncated ? "true" : "false"}</IsTruncated>`,
    ...(options.token ? [`<NextContinuationToken>${options.token}</NextContinuationToken>`] : []),
    "</ListBucketResult>",
  ].join("");
}

test("uses only bucket-scoped List/Get requests and removes downloaded workpieces", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cinaseek-r2-audit-test-"));
  const calls: Array<{ url: URL; method: string }> = [];
  let auditDirectory: string | undefined;
  const bodies = [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
  const keys = [
    "analytics/events/year=2026/month=09/day=03/hour=01/first.parquet",
    "analytics/events/year=2026/month=09/day=03/hour=02/second.parquet",
  ];
  const client = {
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      assert.equal(method, "GET");
      assert.equal(init?.body, undefined);
      if (url.searchParams.has("list-type")) {
        assert.equal(url.searchParams.get("prefix"), "analytics/events/year=2026/month=09/day=03/");
        assert.equal(url.searchParams.get("max-keys"), "500");
        return new Response(listXml([
          { key: keys[0], size: bodies[0].byteLength },
          { key: keys[1], size: bodies[1].byteLength },
          { key: `${keys[0]}.crc`, size: 1 },
        ]));
      }
      const index = url.pathname.endsWith("first.parquet") ? 0 : 1;
      return new Response(bodies[index]);
    },
  };
  try {
    const report = await auditProductAnalyticsR2Day(CONFIG, {
      client,
      now: new Date("2026-09-04T12:00:00Z"),
      tempRoot,
      audit: async paths => {
        assert.equal(paths.length, 2);
        auditDirectory = dirname(paths[0]);
        assert.deepEqual(
          await Promise.all(paths.map(path => readFile(path, "utf8"))),
          ["first", "second"],
        );
        return AUDIT_REPORT;
      },
    });
    assert.deepEqual(report.objects, { count: 2, totalBytes: 11, nonParquetObjects: 1 });
    assert.equal(report.audit, AUDIT_REPORT);
    assert.equal(calls.length, 3);
    await assert.rejects(stat(auditDirectory as string), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("paginates without exposing object keys in the report", async () => {
  const key = "analytics/events/year=2026/month=09/day=03/hour=01/private.parquet";
  let listPage = 0;
  const client = {
    async fetch(input: string | URL | Request): Promise<Response> {
      const url = new URL(String(input));
      if (url.searchParams.has("list-type")) {
        listPage++;
        if (listPage === 1) {
          return new Response(listXml([], { truncated: true, token: "next&amp;page" }));
        }
        assert.equal(url.searchParams.get("continuation-token"), "next&page");
        return new Response(listXml([{ key, size: 1 }]));
      }
      return new Response(new Uint8Array([1]));
    },
  };
  const report = await auditProductAnalyticsR2Day(CONFIG, {
    client,
    now: new Date("2026-09-04T12:00:00Z"),
    audit: async () => AUDIT_REPORT,
  });
  assert.equal(listPage, 2);
  assert.equal(JSON.stringify(report).includes("private.parquet"), false);
});

test("rejects an open UTC day before making a network request", async () => {
  let called = false;
  await assert.rejects(
    auditProductAnalyticsR2Day({ ...CONFIG, day: "2026-09-04" }, {
      client: {
        async fetch(): Promise<Response> {
          called = true;
          return new Response();
        },
      },
      now: new Date("2026-09-04T12:00:00Z"),
    }),
    /earlier than the current UTC date/,
  );
  assert.equal(called, false);
});

test("fails closed on truncated listings without a continuation token", async () => {
  await assert.rejects(
    auditProductAnalyticsR2Day(CONFIG, {
      client: {
        async fetch(): Promise<Response> {
          return new Response(listXml([], { truncated: true }));
        },
      },
      now: new Date("2026-09-04T12:00:00Z"),
    }),
    /omitted its continuation token/,
  );
});

test("fails closed when a provider repeats its continuation token", async () => {
  await assert.rejects(
    auditProductAnalyticsR2Day(CONFIG, {
      client: {
        async fetch(): Promise<Response> {
          return new Response(listXml([], { truncated: true, token: "same-page" }));
        },
      },
      now: new Date("2026-09-04T12:00:00Z"),
    }),
    /repeated its continuation token/,
  );
});

test("fails on an object-size race and still removes its temporary directory", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cinaseek-r2-audit-race-test-"));
  const key = "analytics/events/year=2026/month=09/day=03/hour=01/race.parquet";
  const client = {
    async fetch(input: string | URL | Request): Promise<Response> {
      const url = new URL(String(input));
      return url.searchParams.has("list-type")
        ? new Response(listXml([{ key, size: 2 }]))
        : new Response(new Uint8Array([1]));
    },
  };
  try {
    await assert.rejects(
      auditProductAnalyticsR2Day(CONFIG, {
        client,
        now: new Date("2026-09-04T12:00:00Z"),
        tempRoot,
      }),
      /size changed during the audit/,
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const PARTITION = "analytics/events/year=2026/month=09/day=03/";
const ONE_OBJECT = listXml([{ key: `${PARTITION}one.parquet`, size: 1 }]);

for (const [name, xml] of [
  ["missing pagination state", ONE_OBJECT.replace("<IsTruncated>false</IsTruncated>", "")],
  ["invalid pagination state", ONE_OBJECT.replace("<IsTruncated>false", "<IsTruncated>unknown")],
  ["unfinished XML", ONE_OBJECT.replace("</ListBucketResult>", "")],
  ["unexpected root", ONE_OBJECT.replaceAll("ListBucketResult", "Error")],
  ["duplicate pagination fields", ONE_OBJECT.replace("</ListBucketResult>",
    "<IsTruncated>true</IsTruncated></ListBucketResult>")],
  ["incorrect key count", ONE_OBJECT.replace("<KeyCount>1", "<KeyCount>2")],
  ["missing key count", ONE_OBJECT.replace("<KeyCount>1</KeyCount>", "")],
  ["unexpected encoding", ONE_OBJECT.replace("<EncodingType>url", "<EncodingType>unknown")],
  ["nested object field", ONE_OBJECT.replace("<Key>", "<Key><Unexpected>")
    .replace("</Key>", "</Unexpected></Key>")],
  ["unexpected grouped prefix", ONE_OBJECT.replace("</ListBucketResult>",
    "<CommonPrefixes><Prefix>other/</Prefix></CommonPrefixes></ListBucketResult>")],
  ["DTD declaration", ONE_OBJECT.replace("<ListBucketResult>",
    "<!DOCTYPE ListBucketResult [<!ENTITY test 'value'>]><ListBucketResult>")],
] as const) {
  test(`rejects ${name} before downloading or validating content`, async () => {
    let gets = 0;
    let audits = 0;
    await assert.rejects(auditProductAnalyticsR2Day(CONFIG, {
      now: new Date("2026-09-04T12:00:00Z"),
      client: {
        async fetch(input): Promise<Response> {
          if (new URL(String(input)).searchParams.has("list-type")) return new Response(xml);
          gets++;
          return new Response(new Uint8Array([1]));
        },
      },
      audit: async () => { audits++; return AUDIT_REPORT; },
    }), /R2 list response/);
    assert.equal(gets, 0);
    assert.equal(audits, 0);
  });
}

for (const suffix of ["../../../../outside.parquet", "./one.parquet"]) {
  test(`rejects URL-normalized key segments: ${suffix}`, async () => {
    let gets = 0;
    await assert.rejects(auditProductAnalyticsR2Day(CONFIG, {
      now: new Date("2026-09-04T12:00:00Z"),
      client: {
        async fetch(input): Promise<Response> {
          if (new URL(String(input)).searchParams.has("list-type")) {
            return new Response(listXml([{ key: `${PARTITION}${suffix}`, size: 1 }]));
          }
          gets++;
          return new Response(new Uint8Array([1]));
        },
      },
      audit: async () => AUDIT_REPORT,
    }), /R2 list response/);
    assert.equal(gets, 0);
  });
}

test("rejects duplicate object keys across pages instead of inflating row counts", async () => {
  let pages = 0;
  let gets = 0;
  await assert.rejects(auditProductAnalyticsR2Day(CONFIG, {
    now: new Date("2026-09-04T12:00:00Z"),
    client: {
      async fetch(input): Promise<Response> {
        if (new URL(String(input)).searchParams.has("list-type")) {
          pages++;
          return new Response(listXml([{ key: `${PARTITION}one.parquet`, size: 1 }],
            pages === 1 ? { truncated: true, token: "next-page" } : {}));
        }
        gets++;
        return new Response(new Uint8Array([1]));
      },
    },
    audit: async () => AUDIT_REPORT,
  }), /repeated an object key/);
  assert.equal(pages, 2);
  assert.equal(gets, 0);
});
