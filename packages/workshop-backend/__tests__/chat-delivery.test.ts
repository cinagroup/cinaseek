import { expect, it } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { AiChatMessage, AiChatMetadata } from "@gadgets/workshop-shared/api";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

it("delivers idle metadata only after the pending hydrated message", async () => {
  const storage = makeActionStorage();
  const hydrationStarted = Promise.withResolvers<void>();
  const hydration = Promise.withResolvers<AiChatMessage>();
  const idleDelivered = Promise.withResolvers<void>();
  const events: string[] = [];
  const client = await openFakeOverseer(storage, { impl: {
    addChatSubscriber() {},
    removeChatSubscriber() {},
    streamGeneration: 1,
    logger: { debug() {} },
    chatMetaForClient: (metadata: AiChatMetadata) => metadata,
    hydrateChatMessageForClient: () => {
      hydrationStarted.resolve();
      return hydration.promise;
    },
  } });
  using subscriber = new NativeRpcStub({
    onRpcBroken() {},
    streamGeneration: async () => {},
    metadata: async (metadata: AiChatMetadata) => {
      events.push(metadata.activeAgent ? "active" : "idle");
      if (!metadata.activeAgent) idleDelivered.resolve();
    },
    message: async () => { events.push("message"); },
  });
  // Native and Cap'n Web stub declarations disagree, as in the other native subscription tests.
  using _subscription = await client.subscribeToChat(subscriber as any);
  const metadata: AiChatMetadata = {
    id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0),
    activeAgent: { type: "agent", id: "model", name: "Model" },
  };
  const message: AiChatMessage = {
    type: "message", chatId: 1, sequence: 0, timestamp: new Date(1),
    author: { type: "agent", id: "model", name: "Model" }, message: "Final answer",
  };
  storage.chatMeta.put(metadata);
  storage.chats.put(message);
  // Reusing the writer's object must not erase the queued active notification.
  delete metadata.activeAgent;
  storage.chatMeta.put(metadata);
  await hydrationStarted.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events).toEqual(["active"]);

  hydration.resolve(message);
  await idleDelivered.promise;
  expect(events).toEqual(["active", "message", "idle"]);
});
