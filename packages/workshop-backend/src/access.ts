import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Cloudflare Access settings required to verify an assertion. */
export type CfAccessEnv = Readonly<{
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
}>;

/** Normalized Cloudflare Access settings used by the verifier. */
export type CfAccessConfig = Readonly<{
  audience: string;
  issuer: string;
}>;

/** Business identity derived only from a verified Cloudflare Access assertion. */
export type CfAccessIdentity = Readonly<{
  email: string;
  subject: string;
}>;

type AccessTokenVerifier = (token: string, config: CfAccessConfig) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function settingIsPresent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether either Access setting is present, including a fail-closed partial configuration. */
export function hasCfAccessConfiguration(env: CfAccessEnv): boolean {
  return settingIsPresent(env.CF_ACCESS_AUD) || settingIsPresent(env.CF_ACCESS_ISS);
}

/** Returns a normalized complete Access configuration, or null when Access is fully disabled. */
export function getCfAccessConfig(env: CfAccessEnv): CfAccessConfig | null {
  if (!hasCfAccessConfiguration(env)) return null;

  const audience = env.CF_ACCESS_AUD?.trim();
  const issuerValue = env.CF_ACCESS_ISS?.trim();
  if (!audience || !issuerValue) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  if (audience.length > 64 || /\s/.test(audience)) {
    throw new Error("Cloudflare Access audience is invalid.");
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuerValue);
  } catch {
    throw new Error("Cloudflare Access issuer is invalid.");
  }
  if (issuerUrl.protocol !== "https:" || issuerUrl.port || issuerUrl.username ||
      issuerUrl.password || issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash ||
      !issuerUrl.hostname.endsWith(".cloudflareaccess.com") ||
      issuerUrl.hostname === "cloudflareaccess.com") {
    throw new Error("Cloudflare Access issuer is invalid.");
  }

  return { audience, issuer: issuerUrl.origin };
}

async function verifyToken(token: string, config: CfAccessConfig): Promise<JWTPayload> {
  let jwks = remoteJwkSets.get(config.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`));
    remoteJwkSets.set(config.issuer, jwks);
  }
  return (await jwtVerify(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ["RS256"],
  })).payload;
}

/** Returns verified Cloudflare Access claims, or null when the assertion cannot be trusted. */
export async function verifyCfAccessJwt(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessTokenVerifier = verifyToken): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const config = getCfAccessConfig(env);
    if (!config) return null;
    return await verifier(token, config);
  } catch {
    return null;
  }
}

function normalizeAccessEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Extracts the canonical CinaSeek identity after JWT verification has succeeded. */
export function getCfAccessIdentity(payload: JWTPayload): CfAccessIdentity | null {
  if (payload.type !== "app") return null;
  const email = normalizeAccessEmail(payload.email);
  if (!email) return null;
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject || subject.length > 512) return null;
  return { email, subject };
}

/** Returns a privacy-preserving limiter key derived only from verified Access claims. */
export async function accessRateLimitKey(payload: JWTPayload): Promise<string | null> {
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (subject) return `access-sub:${subject}`;
  const email = normalizeAccessEmail(payload.email);
  if (!email) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return `access-email:${new Uint8Array(digest).toHex()}`;
}
