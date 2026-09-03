import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  REALTIME_PRESENCE_PROTOCOL,
  type PresenceParticipant,
  type RealtimeConsoleMessage,
  type RealtimePresenceMessage,
} from "@gadgets/workshop-shared/api";
import type { RealtimePresenceDurableObject } from "../src/realtime-presence";
import {
  REALTIME_PRESENCE_TICKET_TTL_MS,
  signRealtimePresenceTicket,
  verifyRealtimePresenceTicket,
} from "../src/realtime-presence-ticket";
import type { OverseerDurableObject } from "../src/overseer";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_REALTIME_PRESENCE: DurableObjectNamespace<RealtimePresenceDurableObject>;
    REALTIME_TICKET_SECRET: string;
    REALTIME_CONSOLE_ENABLED: string;
  }
}

const PARTICIPANT: PresenceParticipant = {
  key: "r:user@example.com",
  user: {type: "user", id: "user@example.com", name: "Example User"},
  role: "build",
};

function claims(
    workspaceId: string,
    now = Date.now(),
    participant = PARTICIPANT,
    channel: "presence" | "console" = "presence",
) {
  return {
    channel,
    workspaceId,
    participant,
    role: participant.role,
    nonce: crypto.randomUUID(),
    expiresAt: now + REALTIME_PRESENCE_TICKET_TTL_MS,
  } as const;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", event => resolve(String(event.data)), {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
}

describe("realtime presence tickets", () => {
  it("rejects tampered and expired tickets", async () => {
    let now = Date.now();
    let ticket = await signRealtimePresenceTicket(env.REALTIME_TICKET_SECRET, claims("workspace", now));
    await expect(verifyRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, ticket, now)).resolves.toMatchObject({workspaceId: "workspace"});
    await expect(verifyRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, `${ticket}x`, now)).resolves.toBeNull();
    await expect(verifyRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, ticket, now + REALTIME_PRESENCE_TICKET_TTL_MS)).resolves.toBeNull();
  });

  it("rejects a console ticket for a use-only participant", async () => {
    let participant: PresenceParticipant = {
      ...PARTICIPANT,
      role: "use",
    };
    let ticket = await signRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET,
        claims("workspace", Date.now(), participant, "console"));
    await expect(verifyRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, ticket)).resolves.toBeNull();
  });

  it("rejects a valid ticket offered for a different request workspace", async () => {
    let ticketWorkspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let requestWorkspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let ticket = await signRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, claims(ticketWorkspaceId));
    let response = await SELF.fetch(new Request(
        `https://example.test/api/realtime-presence?workspace=${requestWorkspaceId}`,
        {headers: {
          Upgrade: "websocket",
          Origin: "https://example.test",
          "Sec-WebSocket-Protocol": `${REALTIME_PRESENCE_PROTOCOL}, ${ticket}`,
        }}));

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Realtime workspace mismatch.");
  });
});

describe("RealtimePresenceDurableObject", () => {
  it("accepts a signed ticket once and emits a full roster", async () => {
    let workspaceId = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64);
    let stub = env.TEST_REALTIME_PRESENCE.getByName(workspaceId);
    await stub.syncLegacyPresence(workspaceId, []);
    let ticket = await signRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET, claims(workspaceId));
    let request = new Request(
        `https://example.test/api/realtime-presence?workspace=${workspaceId}`,
        {headers: {
          Upgrade: "websocket",
          Origin: "https://example.test",
          "Sec-WebSocket-Protocol": `${REALTIME_PRESENCE_PROTOCOL}, ${ticket}`,
        }});

    let response = await stub.fetch(request);
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(REALTIME_PRESENCE_PROTOCOL);
    let socket = response.webSocket!;
    socket.accept();
    let message = JSON.parse(await nextMessage(socket)) as RealtimePresenceMessage;
    expect(message).toEqual({type: "presence", participants: [PARTICIPANT]});

    let replay = await stub.fetch(request);
    expect(replay.status).toBe(409);
    socket.close(1000, "test complete");
  });

  it("fans one authoritative roster snapshot out across a canary-sized socket cohort", async () => {
    let workspaceId = crypto.randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64);
    let stub = env.TEST_REALTIME_PRESENCE.getByName(workspaceId);
    await stub.syncLegacyPresence(workspaceId, []);
    let sockets: WebSocket[] = [];
    let finalMessagePromise: Promise<string> | undefined;

    for (let index = 0; index < 25; index++) {
      let participant: PresenceParticipant = {
        key: `r:user-${index}@example.com`,
        user: {type: "user", id: `user-${index}@example.com`, name: `User ${index}`},
        role: index % 2 === 0 ? "build" : "use",
      };
      let ticket = await signRealtimePresenceTicket(
          env.REALTIME_TICKET_SECRET, claims(workspaceId, Date.now(), participant));
      let response = await stub.fetch(new Request(
          `https://example.test/api/realtime-presence?workspace=${workspaceId}`,
          {headers: {
            Upgrade: "websocket",
            Origin: "https://example.test",
            "Sec-WebSocket-Protocol": `${REALTIME_PRESENCE_PROTOCOL}, ${ticket}`,
          }}));
      expect(response.status).toBe(101);
      let socket = response.webSocket!;
      if (index === 24) finalMessagePromise = nextMessage(socket);
      socket.accept();
      sockets.push(socket);
    }

    let finalMessage = JSON.parse(await finalMessagePromise!) as RealtimePresenceMessage;
    expect(finalMessage.type).toBe("presence");
    expect(finalMessage.participants).toHaveLength(25);
    expect(new Set(finalMessage.participants.map(item => item.user.id)).size).toBe(25);
    for (let socket of sockets) socket.close(1000, "test complete");
  });

  it("isolates console fan-out from presence and serializes event timestamps", async () => {
    let workspaceId = crypto.randomUUID().replaceAll("-", "").padEnd(64, "c").slice(0, 64);
    let stub = env.TEST_REALTIME_PRESENCE.getByName(workspaceId);
    let ticket = await signRealtimePresenceTicket(
        env.REALTIME_TICKET_SECRET,
        claims(workspaceId, Date.now(), PARTICIPANT, "console"));
    let response = await stub.fetch(new Request(
        `https://example.test/api/realtime-presence?workspace=${workspaceId}`,
        {headers: {
          Upgrade: "websocket",
          Origin: "https://example.test",
          "Sec-WebSocket-Protocol": `${REALTIME_PRESENCE_PROTOCOL}, ${ticket}`,
        }}));
    expect(response.status).toBe(101);
    let socket = response.webSocket!;
    socket.accept();

    let timestamp = new Date("2026-08-31T12:34:56.789Z");
    let messagePromise = nextMessage(socket);
    await stub.broadcastConsole(workspaceId, 7, [{
      timestamp,
      level: "warn",
      message: ["example", {count: 2}],
    }]);
    let message = JSON.parse(await messagePromise) as RealtimeConsoleMessage;
    expect(message).toEqual({
      type: "console",
      chatId: 7,
      events: [{
        timestamp: timestamp.toISOString(),
        level: "warn",
        message: ["example", {count: 2}],
      }],
    });
    socket.close(1000, "test complete");
  });
});
