import type { JWTPayload } from "jose";
import {
  getCfAccessConfig,
  getCfAccessIdentity,
  verifyCfAccessJwt,
  type CfAccessEnv,
} from "./access.js";

type AccessVerifier = (request: Request, env: CfAccessEnv) => Promise<JWTPayload | null>;

const NO_STORE_HEADERS = {
  "cache-control": "no-store, private",
  "pragma": "no-cache",
};

function methodNotAllowed(): Response {
  return new Response("Method not allowed.", {
    status: 405,
    headers: { ...NO_STORE_HEADERS, allow: "GET" },
  });
}

async function verifyAccessRequest(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessVerifier): Promise<Response | null> {
  try {
    if (!getCfAccessConfig(env)) {
      return new Response("Cloudflare Access is disabled.", {
        status: 404,
        headers: NO_STORE_HEADERS,
      });
    }
  } catch {
    return new Response("Cloudflare Access authentication is misconfigured.", {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }

  const payload = await verifier(request, env);
  if (!payload || !getCfAccessIdentity(payload)) {
    return new Response("Invalid Cloudflare Access session.", {
      status: 401,
      headers: NO_STORE_HEADERS,
    });
  }
  return null;
}

/** Returns a safe same-origin route for the post-login redirect. */
export function safeAccessReturnPath(value: string | null): string {
  if (!value || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//") ||
      value.includes("\\")) {
    return "/";
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("/%2f") || lower.startsWith("/%5c")) return "/";

  try {
    const base = new URL("https://return.invalid/");
    const target = new URL(value, base);
    if (target.origin !== base.origin || target.username || target.password) return "/";
    if (target.pathname === "/auth/login" || target.pathname.startsWith("/auth/login/") ||
        target.pathname.startsWith("/cdn-cgi/access/")) {
      return "/";
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

/** Verify the Access application token and report whether the public shell may open RPC. */
export async function handleAccessSessionRequest(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessVerifier = verifyCfAccessJwt): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const failure = await verifyAccessRequest(request, env, verifier);
  if (failure) return failure;
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}

/** Complete the Access login trigger and redirect to a validated same-origin application route. */
export async function handleAccessLoginRequest(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessVerifier = verifyCfAccessJwt): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const failure = await verifyAccessRequest(request, env, verifier);
  if (failure) return failure;

  const url = new URL(request.url);
  const returnTo = safeAccessReturnPath(url.searchParams.get("returnTo"));
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE_HEADERS, location: returnTo },
  });
}
