import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { PresenceParticipant, RealtimePresenceMessage } from "@gadgets/workshop-shared/api";
import type { RealtimePresenceDurableObject } from "../src/realtime-presence";
import type { RealtimePresenceTicketClaims } from "../src/realtime-presence-ticket";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_REALTIME_PRESENCE: DurableObjectNamespace<RealtimePresenceDurableObject>;
    }
  }
}

const DEPARTING: PresenceParticipant = {
  key: "r:departing@example.com",
  user: {type: "user", id: "departing@example.com", name: "Departing"},
  role: "build",
};
const REMAINING: PresenceParticipant = {
  key: "r:remaining@example.com",
  user: {type: "user", id: "remaining@example.com", name: "Remaining"},
  role: "build",
};

function socketPair(
    state: DurableObjectState,
    participant: PresenceParticipant,
    channel: "presence" | "console" = "presence",
) {
  let pair = new WebSocketPair();
  let client = pair[0];
  let server = pair[1];
  server.serializeAttachment({
    workspaceId: state.id.toString(), participant, channel, role: participant.role,
    nonce: crypto.randomUUID(), expiresAt: Date.now() + 60_000,
  } satisfies RealtimePresenceTicketClaims);
  state.acceptWebSocket(server, [channel]);
  client.accept();
  return {client, server};
}

function nextRoster(socket: WebSocket): Promise<RealtimePresenceMessage> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
}

describe("realtime close handling", () => {
  // Invoke the actual handler with runtime-owned sockets. Reserved codes cannot be sent by a
  // peer, so these cases inject the callback argument, not an impossible wire Close frame.
  it.each([1000, 1001, 1005, 1006, 1015])("handles close code %i and removes the departing participant", async code => {
    let stub = env.TEST_REALTIME_PRESENCE.getByName(`close-code-${code}`);
    await runInDurableObject(stub, async (instance: RealtimePresenceDurableObject, state) => {
      let departing = socketPair(state, DEPARTING);
      let remaining = socketPair(state, REMAINING);
      let close = vi.spyOn(departing.server, "close");
      let warning = vi.spyOn(console, "warn");
      try {
        let roster = nextRoster(remaining.client);
        await instance.webSocketClose(departing.server, code, "peer closed", code < 1005);
        expect(close).toHaveBeenCalledExactlyOnceWith(...(code < 1005 ? [code, "peer closed"] : []));
        expect(warning).not.toHaveBeenCalled();
        expect(await roster).toEqual({type: "presence", participants: [REMAINING]});
      } finally {
        close.mockRestore();
        warning.mockRestore();
        departing.client.close(1000, "test complete");
        remaining.client.close(1000, "test complete");
      }
    });
  });

  it("updates presence even when closing the socket throws", async () => {
    let stub = env.TEST_REALTIME_PRESENCE.getByName("close-throws");
    await runInDurableObject(stub, async (instance: RealtimePresenceDurableObject, state) => {
      let departing = socketPair(state, DEPARTING);
      let remaining = socketPair(state, REMAINING);
      let close = vi.spyOn(departing.server, "close").mockImplementation(() => {
        throw new Error("test close failure");
      });
      let warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let roster = nextRoster(remaining.client);
        await instance.webSocketClose(departing.server, 1000, "peer closed", true);
        expect(await roster).toEqual({type: "presence", participants: [REMAINING]});
        expect(warning).toHaveBeenCalledWith(expect.objectContaining({event: "realtime.socket.close.failed"}));
      } finally {
        close.mockRestore();
        warning.mockRestore();
        departing.client.close(1000, "test complete");
        remaining.client.close(1000, "test complete");
      }
    });
  });

  it("handles the last participant and repeated close callbacks", async () => {
    let stub = env.TEST_REALTIME_PRESENCE.getByName("last-participant-close");
    await runInDurableObject(stub, async (instance: RealtimePresenceDurableObject, state) => {
      let departing = socketPair(state, DEPARTING);
      // A socket without a participant observes the empty roster without adding a member.
      let observer = new WebSocketPair();
      state.acceptWebSocket(observer[1], ["presence"]);
      observer[0].accept();
      try {
        let first = nextRoster(observer[0]);
        await instance.webSocketClose(departing.server, 1006, "", false);
        expect(await first).toEqual({type: "presence", participants: []});
        let repeated = nextRoster(observer[0]);
        await instance.webSocketClose(departing.server, 1006, "", false);
        expect(await repeated).toEqual({type: "presence", participants: []});
      } finally {
        departing.client.close(1000, "test complete");
        observer[0].close(1000, "test complete");
      }
    });
  });

  it("does not broadcast a presence update when a console socket closes", async () => {
    let stub = env.TEST_REALTIME_PRESENCE.getByName("console-close-isolation");
    await runInDurableObject(stub, async (instance: RealtimePresenceDurableObject, state) => {
      let departing = socketPair(state, DEPARTING, "console");
      let remaining = socketPair(state, REMAINING);
      let send = vi.spyOn(remaining.server, "send");
      try {
        await instance.webSocketClose(departing.server, 1006, "", false);
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
        departing.client.close(1000, "test complete");
        remaining.client.close(1000, "test complete");
      }
    });
  });
});
