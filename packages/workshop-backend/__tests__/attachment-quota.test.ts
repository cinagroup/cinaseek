import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    WORKSPACE_BLOBS: R2Bucket;
  }
}

type AttachmentContentRecord = {
  fileId: string;
  data?: Uint8Array;
  blobKey?: string;
  size?: number;
  state: {type: "staged", uploadedAt: number, mimeType: string, name?: string} |
    {type: "committed", chatId: number};
};

type TestOverseer = {
  env: Cloudflare.Env;
  stageChatAttachment(
    id: string,
    attachment: {content: Uint8Array, mimeType: string, name?: string},
  ): Promise<void>;
  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array>;
  deleteChatAttachmentBlobs(keys: string[]): Promise<void>;
  deleteChatAttachmentRecords(ids: Iterable<string>): void;
  storage: {
    workspaceAttachmentUsage: {
      get(): {bytes: number, count: number} | null;
    };
    chatAttachmentContent: {
      get(id: string): AttachmentContentRecord | undefined;
      put(value: AttachmentContentRecord): void;
    };
  };
};

function testOverseer(instance: OverseerDurableObject): TestOverseer {
  return (instance as unknown as {impl: TestOverseer}).impl;
}

async function objectBytes(bucket: R2Bucket, key: string): Promise<Uint8Array | undefined> {
  let object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
}

describe("workspace attachment quota ledger", () => {
  it("maintains aggregate bytes across upload and deletion", async () => {
    let stub = env.TEST_OVERSEER.getByName("attachment-quota-ledger");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let overseer = testOverseer(instance);
      let id = "11111111-1111-4111-8111-111111111111";
      await overseer.stageChatAttachment(id, {
        content: new Uint8Array([1, 2, 3]),
        mimeType: "application/octet-stream",
      });

      expect(overseer.storage.workspaceAttachmentUsage.get())
          .toEqual({bytes: 3, count: 1});
      expect(overseer.storage.chatAttachmentContent.get(id))
          .toMatchObject({data: new Uint8Array([1, 2, 3]), size: 3});

      overseer.deleteChatAttachmentRecords([id, id]);
      expect(overseer.storage.workspaceAttachmentUsage.get())
          .toEqual({bytes: 0, count: 0});
      expect(overseer.storage.chatAttachmentContent.get(id)).toBeUndefined();
    });
  });

  it("mirrors attachment bodies to R2 while retaining the DO fallback", async () => {
    let stub = env.TEST_OVERSEER.getByName("attachment-r2-mirror");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let overseer = testOverseer(instance);
      overseer.env.WORKSPACE_BLOB_MODE = "mirror";
      let id = "22222222-2222-4222-8222-222222222222";
      let data = new Uint8Array([4, 5, 6]);

      await overseer.stageChatAttachment(id, {
        content: data,
        mimeType: "application/octet-stream",
      });

      let record = overseer.storage.chatAttachmentContent.get(id)!;
      expect(record.data).toEqual(data);
      expect(record.blobKey).toBeTruthy();
      expect(await objectBytes(overseer.env.WORKSPACE_BLOBS, record.blobKey!)).toEqual(data);

      await overseer.deleteChatAttachmentBlobs([record.blobKey!]);
      overseer.deleteChatAttachmentRecords([id]);
      expect(await overseer.env.WORKSPACE_BLOBS.get(record.blobKey!)).toBeNull();
      expect(overseer.storage.workspaceAttachmentUsage.get()).toEqual({bytes: 0, count: 0});
    });
  });

  it("stores R2-only bodies, reads them, and lazily promotes legacy DO bodies", async () => {
    let stub = env.TEST_OVERSEER.getByName("attachment-r2-only");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let overseer = testOverseer(instance);
      let r2Id = "33333333-3333-4333-8333-333333333333";
      let r2Data = new Uint8Array([7, 8, 9]);
      overseer.env.WORKSPACE_BLOB_MODE = "r2";
      await overseer.stageChatAttachment(r2Id, {
        content: r2Data,
        mimeType: "application/octet-stream",
      });
      let r2Record = overseer.storage.chatAttachmentContent.get(r2Id)!;
      expect(r2Record.data).toBeUndefined();
      expect(r2Record.blobKey).toBeTruthy();
      overseer.storage.chatAttachmentContent.put({
        ...r2Record,
        state: {type: "committed", chatId: 7},
      });
      let info = vi.spyOn(console, "info").mockImplementation(() => {});
      expect(await overseer.getChatAttachmentData(7, r2Id)).toEqual(r2Data);
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        component: "workshop.overseer",
        event: "chat.attachment.r2.read.completed",
        operation: "read",
        durationMs: expect.any(Number),
      }));
      info.mockRestore();

      let legacyId = "44444444-4444-4444-8444-444444444444";
      let legacyData = new Uint8Array([10, 11]);
      overseer.env.WORKSPACE_BLOB_MODE = "disabled";
      await overseer.stageChatAttachment(legacyId, {
        content: legacyData,
        mimeType: "application/octet-stream",
      });
      let legacyRecord = overseer.storage.chatAttachmentContent.get(legacyId)!;
      overseer.storage.chatAttachmentContent.put({
        ...legacyRecord,
        state: {type: "committed", chatId: 8},
      });

      overseer.env.WORKSPACE_BLOB_MODE = "r2";
      expect(await overseer.getChatAttachmentData(8, legacyId)).toEqual(legacyData);
      let promoted = overseer.storage.chatAttachmentContent.get(legacyId)!;
      expect(promoted.data).toBeUndefined();
      expect(promoted.blobKey).toBeTruthy();
      expect(await objectBytes(overseer.env.WORKSPACE_BLOBS, promoted.blobKey!))
          .toEqual(legacyData);
    });
  });

  it("matches only size-consistent committed or non-expired staged R2 metadata", async () => {
    let stub = env.TEST_OVERSEER.getByName("attachment-cost-control-reconciliation");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let overseer = testOverseer(instance);
      overseer.env.WORKSPACE_BLOB_MODE = "r2";
      let committedId = "55555555-5555-4555-8555-555555555555";
      let stagedId = "66666666-6666-4666-8666-666666666666";
      let expiredId = "77777777-7777-4777-8777-777777777777";
      for (let id of [committedId, stagedId, expiredId]) {
        await overseer.stageChatAttachment(id, {
          content: new Uint8Array([1, 2, 3]),
          mimeType: "application/octet-stream",
        });
      }
      let committed = overseer.storage.chatAttachmentContent.get(committedId)!;
      let staged = overseer.storage.chatAttachmentContent.get(stagedId)!;
      let expired = overseer.storage.chatAttachmentContent.get(expiredId)!;
      overseer.storage.chatAttachmentContent.put({
        ...committed,
        state: {type: "committed", chatId: 1},
      });
      overseer.storage.chatAttachmentContent.put({
        ...expired,
        state: {type: "staged", uploadedAt: 0, mimeType: "application/octet-stream"},
      });

      expect(instance.matchWorkspaceBlobMetadataForCostControl([
        {key: committed.blobKey!, size: 3},
        {key: staged.blobKey!, size: 3},
        {key: expired.blobKey!, size: 3},
      ])).toEqual([committed.blobKey, staged.blobKey]);
      expect(instance.matchWorkspaceBlobMetadataForCostControl([
        {key: committed.blobKey!, size: 4},
      ])).toEqual([]);
    });
  });
});
