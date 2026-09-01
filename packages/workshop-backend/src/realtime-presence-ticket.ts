import type {
  CollaboratorRole,
  PresenceParticipant,
} from "@gadgets/workshop-shared/api";

const encoder = new TextEncoder();

/** Maximum lifetime of a realtime presence connection ticket. */
export const REALTIME_PRESENCE_TICKET_TTL_MS = 60_000;

/** Authenticated claims carried by a realtime presence connection ticket. */
export type RealtimePresenceTicketClaims = {
  channel: "presence" | "console";
  workspaceId: string;
  participant: PresenceParticipant;
  role: CollaboratorRole;
  nonce: string;
  expiresAt: number;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    let padded = value.replaceAll("-", "+").replaceAll("_", "/");
    padded += "=".repeat((4 - padded.length % 4) % 4);
    let binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("REALTIME_TICKET_SECRET must contain at least 32 bytes.");
  }
  return crypto.subtle.importKey(
      "raw", encoder.encode(secret), {name: "HMAC", hash: "SHA-256"}, false,
      ["sign", "verify"]);
}

function isRole(value: unknown): value is CollaboratorRole {
  return value === "build" || value === "use";
}

function parseClaims(value: unknown): RealtimePresenceTicketClaims | null {
  if (!value || typeof value !== "object") return null;
  let record = value as Record<string, unknown>;
  let participant = record.participant;
  if (!participant || typeof participant !== "object") return null;
  let participantRecord = participant as Record<string, unknown>;
  let user = participantRecord.user;
  if (!user || typeof user !== "object") return null;
  let userRecord = user as Record<string, unknown>;
  if ((record.channel !== "presence" && record.channel !== "console") ||
      typeof record.workspaceId !== "string" || !record.workspaceId ||
      typeof record.nonce !== "string" || !record.nonce ||
      typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) ||
      !isRole(record.role) || typeof participantRecord.key !== "string" ||
      (record.channel === "console" && record.role !== "build") ||
      !isRole(participantRecord.role) || participantRecord.role !== record.role ||
      typeof userRecord.id !== "string" || !userRecord.id ||
      typeof userRecord.name !== "string" || !userRecord.name ||
      (userRecord.type !== "user" && userRecord.type !== "agent" &&
       userRecord.type !== "gadget")) {
    return null;
  }
  return value as RealtimePresenceTicketClaims;
}

/** Sign short-lived claims for a hibernatable workspace realtime WebSocket. */
export async function signRealtimePresenceTicket(
    secret: string,
    claims: RealtimePresenceTicketClaims,
): Promise<string> {
  let payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  let signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Verify and decode a hibernatable workspace realtime ticket without trusting its JSON shape. */
export async function verifyRealtimePresenceTicket(
    secret: string,
    ticket: string,
    now = Date.now(),
): Promise<RealtimePresenceTicketClaims | null> {
  let parts = ticket.split(".");
  if (parts.length !== 2) return null;
  let payload = decodeBase64Url(parts[0]);
  let signature = decodeBase64Url(parts[1]);
  if (!payload || !signature) return null;
  let valid = await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), signature, encoder.encode(parts[0]));
  if (!valid) return null;
  try {
    let claims = parseClaims(JSON.parse(new TextDecoder().decode(payload)));
    if (!claims || claims.expiresAt <= now ||
        claims.expiresAt > now + REALTIME_PRESENCE_TICKET_TTL_MS) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
