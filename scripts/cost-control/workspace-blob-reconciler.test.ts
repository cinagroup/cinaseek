import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudflareAlertMetricsClient } from "./cloudflare-alert-metrics.ts";
import {
  reconcileWorkspaceBlobs,
  type WorkspaceBlobBucket,
  type WorkspaceBlobMetadataService,
} from "./workspace-blob-reconciler.ts";

const LIVE = "a".repeat(64);
const DELETED = "b".repeat(64);
const FILE_ONE = "00000000-0000-4000-8000-000000000001";
const FILE_TWO = "00000000-0000-4000-8000-000000000002";

describe("workspace blob reconciler", () => {
  it("counts invalid, deleted-workspace, and unmatched metadata bytes as orphaned", async () => {
    const pages = [
      {
        objects: [
          { key: `workspaces/${LIVE}/chat-attachments/${FILE_ONE}`, size: 10 },
          { key: `workspaces/${LIVE}/chat-attachments/${FILE_TWO}`, size: 20 },
          { key: `workspaces/${DELETED}/chat-attachments/${FILE_ONE}`, size: 30 },
        ],
        truncated: true,
        cursor: "next",
      },
      {
        objects: [{ key: "workspaces/not-an-attachment", size: 40 }],
        truncated: false,
      },
    ];
    let listCalls = 0;
    const bucket: WorkspaceBlobBucket = {
      async list() { return pages[listCalls++]; },
    };
    const serviceCalls: string[] = [];
    const service: WorkspaceBlobMetadataService = {
      async matchWorkspaceBlobMetadata(workspaceId, objects) {
        serviceCalls.push(workspaceId);
        return objects.filter(object => object.size === 10).map(object => object.key);
      },
    };
    const client = {
      async queryOverseerObjectIds() { return [LIVE]; },
    } as unknown as CloudflareAlertMetricsClient;

    assert.deepEqual(await reconcileWorkspaceBlobs(client, bucket, service), {
      orphanBytes: 90,
      scannedBytes: 100,
      scannedObjects: 4,
      storedWorkspaces: 1,
    });
    assert.deepEqual(serviceCalls, [LIVE]);
  });

  it("fails closed on a repeating R2 cursor", async () => {
    const bucket: WorkspaceBlobBucket = {
      async list() { return { objects: [], truncated: true, cursor: "same" }; },
    };
    const client = {
      async queryOverseerObjectIds() { return []; },
    } as unknown as CloudflareAlertMetricsClient;
    const service = {
      async matchWorkspaceBlobMetadata() { return []; },
    };

    await assert.rejects(
      () => reconcileWorkspaceBlobs(client, bucket, service),
      /cursor/,
    );
  });
});
