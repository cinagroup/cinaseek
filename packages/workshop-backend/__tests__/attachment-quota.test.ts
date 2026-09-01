import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

describe("workspace attachment quota ledger", () => {
  it("maintains aggregate bytes across upload and deletion", async () => {
    let stub = env.TEST_OVERSEER.getByName("attachment-quota-ledger");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let overseer = instance as unknown as {
        impl: {
          stageChatAttachment(
            id: string,
            attachment: {content: Uint8Array, mimeType: string},
          ): Promise<void>;
          deleteChatAttachmentRecords(ids: Iterable<string>): void;
          storage: {
            workspaceAttachmentUsage: {
              get(): {bytes: number, count: number} | null;
            };
            chatAttachmentContent: {
              get(id: string): {data?: Uint8Array, size?: number} | undefined;
            };
          };
        };
      };
      let id = "11111111-1111-4111-8111-111111111111";
      await overseer.impl.stageChatAttachment(id, {
        content: new Uint8Array([1, 2, 3]),
        mimeType: "application/octet-stream",
      });

      expect(overseer.impl.storage.workspaceAttachmentUsage.get())
          .toEqual({bytes: 3, count: 1});
      expect(overseer.impl.storage.chatAttachmentContent.get(id))
          .toMatchObject({data: new Uint8Array([1, 2, 3]), size: 3});

      overseer.impl.deleteChatAttachmentRecords([id, id]);
      expect(overseer.impl.storage.workspaceAttachmentUsage.get())
          .toEqual({bytes: 0, count: 0});
      expect(overseer.impl.storage.chatAttachmentContent.get(id)).toBeUndefined();
    });
  });
});
