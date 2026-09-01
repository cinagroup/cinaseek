import {
  REALTIME_PRESENCE_PROTOCOL,
  type ConsoleLogEvent,
  type PresenceParticipant,
  type RealtimeConsoleMessage,
  type RealtimePresenceMessage,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import { createWorkshopLogger } from "./observability";
import {
  verifyRealtimePresenceTicket,
  type RealtimePresenceTicketClaims,
} from "./realtime-presence-ticket";

const logger = createWorkshopLogger("workshop.realtime-presence");
const LEGACY_PARTICIPANTS_KEY = "legacyParticipants";
const WORKSPACE_ID_KEY = "workspaceId";

type RealtimeSocketAttachment = RealtimePresenceTicketClaims;

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function strongerRole(
    left: PresenceParticipant["role"],
    right: PresenceParticipant["role"],
): PresenceParticipant["role"] {
  return left === "build" || right === "build" ? "build" : "use";
}

/**
 * Per-workspace hibernatable realtime fan-out for presence snapshots and best-effort console
 * events. Channel tags keep authorization and fan-out isolated while sharing one workspace DO.
 */
export class RealtimePresenceDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS consumed_tickets (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS consumed_tickets_by_expiry
        ON consumed_tickets(expires_at);
    `);
  }

  async syncLegacyPresence(
      workspaceId: string,
      participants: PresenceParticipant[],
  ): Promise<void> {
    let storedWorkspaceId = await this.ctx.storage.get<string>(WORKSPACE_ID_KEY);
    if (storedWorkspaceId !== undefined && storedWorkspaceId !== workspaceId) {
      throw new Error("Realtime workspace identity mismatch.");
    }
    await this.ctx.storage.put({
      [WORKSPACE_ID_KEY]: workspaceId,
      [LEGACY_PARTICIPANTS_KEY]: participants,
    });
    await this.#broadcastPresence();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", {status: 426});
    }

    let protocols = offeredProtocols(request);
    if (protocols[0] !== REALTIME_PRESENCE_PROTOCOL || !protocols[1]) {
      return new Response("Realtime protocol and ticket required.", {status: 401});
    }
    let secret = this.env.REALTIME_TICKET_SECRET;
    if (!secret) return new Response("Realtime presence is disabled.", {status: 503});

    let claims: RealtimePresenceTicketClaims | null;
    try {
      claims = await verifyRealtimePresenceTicket(secret, protocols[1]);
    } catch (error) {
      logger.error("invalid realtime ticket configuration", {
        event: "realtime.ticket.config.invalid", error,
      });
      return new Response("Realtime presence is unavailable.", {status: 503});
    }
    if (!claims) return new Response("Invalid or expired realtime ticket.", {status: 401});
    if (claims.channel === "console" && this.env.REALTIME_CONSOLE_ENABLED !== "true") {
      return new Response("Realtime console delivery is disabled.", {status: 503});
    }

    let requestedWorkspaceId = new URL(request.url).searchParams.get("workspace");
    if (requestedWorkspaceId !== claims.workspaceId) {
      return new Response("Realtime workspace mismatch.", {status: 403});
    }
    let storedWorkspaceId = await this.ctx.storage.get<string>(WORKSPACE_ID_KEY);
    if (storedWorkspaceId !== undefined && storedWorkspaceId !== claims.workspaceId) {
      return new Response("Realtime workspace mismatch.", {status: 403});
    }

    // A signed ticket is one-use. SQLite's synchronous transaction makes concurrent replays race
    // on one unique insert; only the winner may attach a socket.
    try {
      this.ctx.storage.sql.exec(
          "INSERT INTO consumed_tickets (nonce, expires_at) VALUES (?, ?)",
          claims.nonce, claims.expiresAt);
    } catch {
      return new Response("Realtime ticket was already used.", {status: 409});
    }
    this.ctx.storage.sql.exec("DELETE FROM consumed_tickets WHERE expires_at <= ?", Date.now());
    await this.ctx.storage.put(WORKSPACE_ID_KEY, claims.workspaceId);

    let pair = new WebSocketPair();
    let [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment(claims satisfies RealtimeSocketAttachment);
    this.ctx.acceptWebSocket(server, [claims.channel]);

    if (claims.channel === "presence") {
      await this.#broadcastPresence();
      this.ctx.waitUntil(this.#notifyOverseer(claims.workspaceId));
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {"Sec-WebSocket-Protocol": REALTIME_PRESENCE_PROTOCOL},
    });
  }

  async webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    let presence = this.#attachment(socket)?.channel === "presence";
    socket.close(1008, "This realtime channel is server-push only.");
    if (presence) await this.#presenceChanged(socket);
  }

  async webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      _wasClean: boolean,
  ): Promise<void> {
    let presence = this.#attachment(socket)?.channel === "presence";
    socket.close(code, reason);
    if (presence) await this.#presenceChanged(socket);
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    let presence = this.#attachment(socket)?.channel === "presence";
    logger.warn("realtime socket failed", {
      event: "realtime.socket.failed", error,
    });
    socket.close(1011, "Realtime channel failed.");
    if (presence) await this.#presenceChanged(socket);
  }

  async broadcastConsole(
      workspaceId: string,
      chatId: number | null,
      events: ConsoleLogEvent[],
  ): Promise<void> {
    let storedWorkspaceId = await this.ctx.storage.get<string>(WORKSPACE_ID_KEY);
    if (storedWorkspaceId !== undefined && storedWorkspaceId !== workspaceId) {
      throw new Error("Realtime workspace identity mismatch.");
    }
    if (storedWorkspaceId === undefined) await this.ctx.storage.put(WORKSPACE_ID_KEY, workspaceId);

    let message: RealtimeConsoleMessage = {
      type: "console",
      chatId,
      events: events.map(event => ({
        ...event,
        timestamp: event.timestamp.toISOString(),
      })),
    };
    let encoded = JSON.stringify(message);
    for (let socket of this.ctx.getWebSockets("console")) {
      try {
        socket.send(encoded);
      } catch (error) {
        logger.warn("failed to broadcast realtime console events", {
          event: "realtime.console.broadcast.failed", error,
        });
      }
    }
  }

  async #presenceChanged(exclude?: WebSocket): Promise<void> {
    let workspaceId = this.#workspaceId(exclude) ??
      await this.ctx.storage.get<string>(WORKSPACE_ID_KEY);
    await this.#broadcastPresence(exclude);
    if (workspaceId) await this.#notifyOverseer(workspaceId, exclude);
  }

  #attachment(socket: WebSocket): RealtimeSocketAttachment | undefined {
    let attachment = socket.deserializeAttachment() as RealtimeSocketAttachment | null;
    return attachment ?? undefined;
  }

  #workspaceId(exclude?: WebSocket): string | undefined {
    for (let socket of this.ctx.getWebSockets("presence")) {
      if (socket === exclude) continue;
      let attachment = this.#attachment(socket);
      if (attachment) return attachment.workspaceId;
    }
    return exclude && this.#attachment(exclude)?.workspaceId;
  }

  #modernParticipants(exclude?: WebSocket): PresenceParticipant[] {
    let participants = new Map<string, PresenceParticipant>();
    for (let socket of this.ctx.getWebSockets("presence")) {
      if (socket === exclude) continue;
      let participant = this.#attachment(socket)?.participant;
      if (!participant) continue;
      let current = participants.get(participant.user.id);
      participants.set(participant.user.id, current ? {
        ...current,
        role: strongerRole(current.role, participant.role),
      } : participant);
    }
    return [...participants.values()];
  }

  async #combinedParticipants(exclude?: WebSocket): Promise<PresenceParticipant[]> {
    let combined = new Map<string, PresenceParticipant>();
    let legacy = await this.ctx.storage.get<PresenceParticipant[]>(LEGACY_PARTICIPANTS_KEY) ?? [];
    for (let participant of [...legacy, ...this.#modernParticipants(exclude)]) {
      let current = combined.get(participant.user.id);
      combined.set(participant.user.id, current ? {
        ...current,
        role: strongerRole(current.role, participant.role),
      } : participant);
    }
    return [...combined.values()];
  }

  async #broadcastPresence(exclude?: WebSocket): Promise<void> {
    let message: RealtimePresenceMessage = {
      type: "presence",
      participants: await this.#combinedParticipants(exclude),
    };
    let encoded = JSON.stringify(message);
    for (let socket of this.ctx.getWebSockets("presence")) {
      if (socket === exclude) continue;
      try {
        socket.send(encoded);
      } catch (error) {
        logger.warn("failed to broadcast realtime presence", {
          event: "realtime.broadcast.failed", error,
        });
      }
    }
  }

  async #notifyOverseer(workspaceId: string, exclude?: WebSocket): Promise<void> {
    try {
      let legacy = await this.ctx.storage.get<PresenceParticipant[]>(LEGACY_PARTICIPANTS_KEY) ?? [];
      if (legacy.length === 0) return;
      let namespace = this.ctx.exports.OverseerDurableObject;
      let overseer = namespace.get(namespace.idFromString(workspaceId));
      await overseer.updateRealtimePresence(this.#modernParticipants(exclude));
    } catch (error) {
      logger.warn("failed to mirror realtime presence to legacy subscribers", {
        event: "realtime.legacy-mirror.failed", gadgetId: workspaceId, error,
      });
    }
  }
}
