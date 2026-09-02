import { describe, expect, it, vi } from "vitest";

import { recordAnalytics } from "../src/analytics";
import type { ProductAnalyticsRecord } from "../src/analytics";

function testContext() {
  let pending: Promise<unknown>[] = [];
  let ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as ExecutionContext;
  return { ctx, pending };
}

describe("recordAnalytics", () => {
  it("emits bounded cost-control counters without attribution identifiers", () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let { ctx } = testContext();

    recordAnalytics(ctx, {} as Cloudflare.Env, {
      event_name: "workspace_session_finished",
      user_id: "must-not-log-user",
      gadget_id: "must-not-log-workspace",
      session_id: "must-not-log-session",
      duration_ms: 1234,
      outcome: "connection_lost",
    });

    expect(info).toHaveBeenCalledOnce();
    let fields = info.mock.calls[0][0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      component: "workshop.analytics",
      event: "cost.metric.workspace.session.finished",
      durationMs: 1234,
      operation: "connection_lost",
    });
    expect(JSON.stringify(fields)).not.toContain("must-not-log");
    info.mockRestore();
  });

  it("hoists common fields and keeps operational dimensions in properties", async () => {
    let sent: ProductAnalyticsRecord[][] = [];
    let send = vi.fn(async (records: ProductAnalyticsRecord[]) => {
      sent.push(records);
    });
    let env = { PRODUCT_ANALYTICS: { send } } as Cloudflare.Env;
    let { ctx, pending } = testContext();

    recordAnalytics(ctx, env, {
      event_name: "workspace_session_finished",
      user_id: "user-id",
      gadget_id: "workspace-id",
      session_id: "session-id",
      duration_ms: 1234,
      outcome: "closed",
    });

    await Promise.all(pending);
    expect(send).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({
      event_name: "workspace_session_finished",
      user_id: "user-id",
      gadget_id: "workspace-id",
      properties: {
        session_id: "session-id",
        duration_ms: 1234,
        outcome: "closed",
      },
    });
    expect(sent[0][0].event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(sent[0][0].event_ts))).toBe(false);
  });

  it("does nothing when the optional pipeline is not configured", () => {
    let { ctx, pending } = testContext();

    recordAnalytics(ctx, {} as Cloudflare.Env, {
      event_name: "dynamic_worker_requested",
      gadget_id: "workspace-id",
      worker_id: "worker-id",
      workpiece_id: 1,
      execution_version: "7.2.4",
      mode: "preview",
      chat_id: 2,
    });

    expect(pending).toEqual([]);
  });
});
