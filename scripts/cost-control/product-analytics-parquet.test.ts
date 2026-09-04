import assert from "node:assert/strict";
import test from "node:test";

import { analyzeProductAnalyticsRows } from "./product-analytics-parquet.ts";

const FILES = { count: 1, names: ["events.parquet"], totalBytes: 123 };

function row(overrides: Record<string, unknown> = {}): { source: string; value: unknown } {
  return {
    source: "events.parquet",
    value: {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_ts: new Date("2026-09-04T00:00:00Z"),
      event_name: "dynamic_worker_requested",
      user_id: "private-user",
      gadget_id: "private-workspace",
      properties: JSON.stringify({
        worker_id: "private-worker",
        workpiece_id: 2,
        execution_version: "private-version",
        mode: "mainline",
      }),
      ...overrides,
    },
  };
}

test("deduplicates identical event ids and never returns raw identifiers", () => {
  const report = analyzeProductAnalyticsRows([row(), row()], FILES);
  assert.equal(report.valid, true);
  assert.deepEqual(report.rows, {
    raw: 2,
    valid: 2,
    unique: 1,
    duplicateCopies: 1,
    duplicateEventIds: 1,
    conflictingDuplicateEventIds: 0,
  });
  assert.deepEqual(report.events.dynamic_worker_requested, { raw: 2, unique: 1 });
  assert.equal(report.dynamicWorkers.requests, 1);
  const serialized = JSON.stringify(report);
  for (const secret of ["private-user", "private-workspace", "private-worker", "private-version"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("fails closed when one event id names conflicting payloads", () => {
  const report = analyzeProductAnalyticsRows([
    row(),
    row({ event_name: "workspace_session_started" }),
  ], FILES);
  assert.equal(report.valid, false);
  assert.equal(report.rows.conflictingDuplicateEventIds, 1);
  assert.equal(report.duplicates[0]?.conflicting, true);
});

test("groups mainline and preview identities independently", () => {
  const preview = row({
    event_id: "22222222-2222-4222-8222-222222222222",
    properties: JSON.stringify({
      worker_id: "preview-worker",
      workpiece_id: 2,
      execution_version: "preview-version",
      mode: "preview",
      chat_id: 7,
    }),
  });
  const report = analyzeProductAnalyticsRows([row(), preview], FILES);
  assert.equal(report.valid, true);
  assert.deepEqual({
    requests: report.dynamicWorkers.requests,
    workspaces: report.dynamicWorkers.workspaces,
    workpieces: report.dynamicWorkers.workpieces,
    workerIds: report.dynamicWorkers.workerIds,
    executionVersions: report.dynamicWorkers.executionVersions,
    mainlineWorkerIds: report.dynamicWorkers.mainlineWorkerIds,
    previewWorkerIds: report.dynamicWorkers.previewWorkerIds,
  }, {
    requests: 2,
    workspaces: 1,
    workpieces: 1,
    workerIds: 2,
    executionVersions: 2,
    mainlineWorkerIds: 1,
    previewWorkerIds: 1,
  });
  assert.deepEqual(report.dynamicWorkers.observations.map(entry => entry.mode).toSorted(),
    ["mainline", "preview"]);
  assert.ok(report.dynamicWorkers.observations.find(entry => entry.mode === "preview")?.chat);
});

test("accepts Parquet null for an optional gadget id", () => {
  const report = analyzeProductAnalyticsRows([row({
    event_name: "user_authenticated",
    gadget_id: null,
    properties: "{}",
  })], FILES);
  assert.equal(report.valid, true);
  assert.deepEqual(report.events.user_authenticated, { raw: 1, unique: 1 });
  assert.equal(report.dynamicWorkers.requests, 0);
});

test("rejects malformed common and Dynamic Worker fields without echoing values", () => {
  const report = analyzeProductAnalyticsRows([
    row({ event_id: "not-a-uuid" }),
    row({
      event_id: "33333333-3333-4333-8333-333333333333",
      properties: JSON.stringify({
        worker_id: "sensitive-bad-worker",
        workpiece_id: 2,
        execution_version: "version",
        mode: "preview",
      }),
    }),
    row({
      event_id: "44444444-4444-4444-8444-444444444444",
      properties: JSON.stringify({
        worker_id: "worker",
        workpiece_id: 2,
        execution_version: "version",
        mode: "mainline",
        chat_id: 9,
      }),
    }),
  ], FILES);
  assert.equal(report.valid, false);
  assert.deepEqual(report.issues.map(issue => issue.reason), [
    "event_id is not a supported UUID",
    "dynamic_worker_requested has invalid identity properties",
    "dynamic_worker_requested has invalid identity properties",
  ]);
  assert.equal(JSON.stringify(report).includes("sensitive-bad-worker"), false);
});
