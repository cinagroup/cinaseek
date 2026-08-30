import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  WorkersAiCredentials,
  WorkersAiGatekeeperUser,
  WorkersAiModelInfo,
  WorkersAiTask,
} from "@gadgets/workshop-shared/workers-ai-gatekeeper";
import type { WorkersAiModelConfiguratorRpc } from "./configurator/model-configurator-types";
import MODEL_CONFIGURATOR_HTML from "./generated/model-configurator-ui.txt";
import {
  WorkersAiApi,
  WorkersAiApiError,
  normalizeWorkersAiCredentials,
  normalizeWorkersAiModelId,
} from "./workers-ai-api.js";
import {
  WorkersAiClassificationSessionImpl,
  WorkersAiEmbeddingsSessionImpl,
  WorkersAiImageGenerationSessionImpl,
  WorkersAiSpeechRecognitionSessionImpl,
  WorkersAiTextToSpeechSessionImpl,
} from "./sessions.js";
import type {
  WorkersAiClassificationSession,
  WorkersAiEmbeddingsSession,
  WorkersAiImageGenerationSession,
  WorkersAiSpeechRecognitionSession,
  WorkersAiTextToSpeechSession,
} from "./types";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & { BASE_URL?: string };

type WorkersAiLogFields = {
  event?: string;
  vendorId: string;
  modelId?: string;
  task?: WorkersAiTask;
  status?: number;
  codes?: number[];
};

const VENDOR_ID = "workers_ai";
const logger = createLogger<WorkersAiLogFields>({
  component: "gatekeeper.workers-ai",
  vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const CATALOG_CACHE_VERSION = 2;
const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONNECT_PATH = "connect";
const SUPPORTED_RESOURCE_PATH = "_resource/model";

const TASK_DETAILS: Record<Exclude<WorkersAiTask, "text-generation">, {
  title: string;
  snippet: string;
  bindingName: string;
  tsType: string;
}> = {
  "text-embeddings": {
    title: "Workers AI embeddings",
    snippet: "Generate vector embeddings for text.",
    bindingName: "WORKERS_AI_EMBEDDINGS",
    tsType: "WorkersAiEmbeddingsSession",
  },
  "text-to-image": {
    title: "Workers AI image generator",
    snippet: "Generate images from text prompts.",
    bindingName: "WORKERS_AI_IMAGE_GENERATOR",
    tsType: "WorkersAiImageGenerationSession",
  },
  "automatic-speech-recognition": {
    title: "Workers AI speech recognition",
    snippet: "Transcribe audio into text.",
    bindingName: "WORKERS_AI_TRANSCRIBER",
    tsType: "WorkersAiSpeechRecognitionSession",
  },
  "text-to-speech": {
    title: "Workers AI text to speech",
    snippet: "Synthesize speech audio from text.",
    bindingName: "WORKERS_AI_SPEECH_SYNTHESIZER",
    tsType: "WorkersAiTextToSpeechSession",
  },
  "text-classification": {
    title: "Workers AI text classifier",
    snippet: "Classify text and return scored labels.",
    bindingName: "WORKERS_AI_CLASSIFIER",
    tsType: "WorkersAiClassificationSession",
  },
};

const CLOUDFLARE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74">` +
  `<path fill="#f4801f" d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.75,22.27-16.71l4.34-11.36a2.68,2.68,0,0,0,.18-1,3.31,3.31,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z"/>` +
  `<path fill="#f9ab41" d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.09.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.55,1.55,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z"/>` +
  `</svg>`;
const CLOUDFLARE_LOGO: AvatarImage = {
  url: `data:image/svg+xml,${encodeURIComponent(CLOUDFLARE_LOGO_SVG)}`,
};

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/workers-ai");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function modelResource(env: Env): SupportedResource {
  return {
    urlPattern: `${getBaseUrl(env)}/${SUPPORTED_RESOURCE_PATH}/:modelKey`,
    title: "Workers AI model",
    description: "Bind one embeddings, image, speech, or classification model.",
    icon: CLOUDFLARE_LOGO,
  };
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  return aBytes.byteLength === bBytes.byteLength && crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Workers AI resource URL.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid Workers AI resource URL.");
  }
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}

function resourceUrl(env: Env, modelId: string): string {
  return `${getBaseUrl(env)}/${SUPPORTED_RESOURCE_PATH}/${base64UrlEncode(modelId)}`;
}

function parseResourceUrl(env: Env, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid Workers AI resource URL.");
  }
  const base = new URL(getBaseUrl(env));
  if (parsed.origin !== base.origin || parsed.search || parsed.hash) {
    throw new Error("Invalid Workers AI resource URL.");
  }
  const prefix = `${getBasePath(env)}/${SUPPORTED_RESOURCE_PATH}/`;
  if (!parsed.pathname.startsWith(prefix)) throw new Error("Invalid Workers AI resource URL.");
  const key = parsed.pathname.slice(prefix.length);
  if (!key || key.includes("/")) throw new Error("Invalid Workers AI resource URL.");
  return normalizeWorkersAiModelId(base64UrlDecode(key));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

const CONNECT_FORM_HTML = (actionUrl: string, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Cloudflare Workers AI</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7fa;margin:0;min-height:100vh;display:grid;place-items:center;color:#202124}
.card{width:min(560px,calc(100% - 32px));box-sizing:border-box;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;box-shadow:0 14px 40px #0f172a14}
.brand{display:flex;align-items:center;gap:12px}.brand img{width:42px;height:42px}.brand h1{font-size:21px;margin:0}.lead{color:#586174;line-height:1.55}
label{display:block;font-weight:650;margin:18px 0 6px}input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font:14px ui-monospace,monospace}
.hint{font-size:12px;color:#697386;margin-top:6px;line-height:1.45}.error{background:#fff1f2;color:#be123c;border:1px solid #fecdd3;padding:10px 12px;border-radius:9px}
button{margin-top:22px;width:100%;border:0;border-radius:9px;padding:12px;background:#f48120;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
a{color:#c75d00}</style></head><body><main class="card">
<div class="brand"><img alt="Cloudflare" src="${CLOUDFLARE_LOGO.url}"><h1>Connect Cloudflare Workers AI</h1></div>
<p class="lead">Use your own Cloudflare account for CinaSeek chat, embeddings, image, speech, and classification models.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(actionUrl)}">
<label for="accountId">Cloudflare Account ID</label><input id="accountId" name="accountId" required maxlength="32" autocomplete="off" placeholder="32 hexadecimal characters">
<div class="hint">Dashboard → Workers AI → Use REST API.</div>
<label for="token">Workers AI API Token</label><input id="token" name="token" type="password" required autocomplete="new-password" placeholder="API token with Workers AI Read or Write">
<div class="hint">The token stays server-side and is never sent to gadgets or other users.</div>
<button type="submit">Connect Workers AI</button></form></main></body></html>`;

const INVALID_LINK_HTML = `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:3rem"><h2>Connection link expired</h2><p>Return to CinaSeek and try again.</p></body></html>`;
const SELF_CLOSING_HTML = `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:3rem"><script>window.close()</script><h2>Workers AI connected</h2><p>You may close this tab and return to CinaSeek.</p></body></html>`;

type StoredNonce = { value: string; expiresAt: number };
type StoredCatalog = {
  version?: number;
  expiresAt: number;
  models: WorkersAiModelInfo[];
};
type StoredSchemaFields = { expiresAt: number; fields: string[] };
type CompleteConnectionResult = { kind: "ok" } | { kind: "invalid_nonce" } |
  { kind: "error"; message: string };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      return new Response("Not Found", { status: 404 });
    }
    const segments = url.pathname.slice(basePath.length).split("/").filter(Boolean);

    if (segments[0] === CONNECT_PATH && segments.length === 3 &&
        segments[1].length === 64 && segments[2].length === NONCE_BYTES * 2) {
      const account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(segments[1]));
      const nonce = segments[2];
      if (request.method === "GET") {
        if (!await account.verifyNonceWithoutConsuming(nonce)) {
          return new Response(INVALID_LINK_HTML, {
            status: 400, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(CONNECT_FORM_HTML(request.url), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "POST") {
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const result = await account.completeConnection(
          nonce,
          String(form.get("accountId") ?? ""),
          String(form.get("token") ?? ""),
        );
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, {
            status: 400, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (result.kind === "error") {
          return new Response(CONNECT_FORM_HTML(request.url, result.message), {
            status: 400, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(SELF_CLOSING_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (segments[0] === SUPPORTED_RESOURCE_PATH.split("/")[0] && request.method === "GET") {
      return new Response("This Workers AI model is configured through CinaSeek.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};

/** Top-level Workers AI connector vendor. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare Workers AI",
      url: "https://developers.cloudflare.com/workers-ai/",
      logo: CLOUDFLARE_LOGO,
      color: "#fff1e8",
      tagline: "Use your own Cloudflare account for chat and typed AI capabilities",
      description:
        "Connect one Cloudflare Account ID and API Token, then choose text-generation models in " +
        "Providers or bind embeddings, image, speech, and classification models to a Gadget.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${CONNECT_PATH}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [modelResource(this.env)];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

/** Credential store and account-scoped model catalog cache. */
export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<WorkersAiCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  verifyNonceWithoutConsuming(nonce: string): boolean {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !!stored && Date.now() < stored.expiresAt && constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(
    nonce: string,
    accountId: string,
    apiToken: string,
  ): Promise<CompleteConnectionResult> {
    if (!this.verifyNonceWithoutConsuming(nonce)) return { kind: "invalid_nonce" };
    let credentials: WorkersAiCredentials;
    let models: WorkersAiModelInfo[];
    try {
      credentials = normalizeWorkersAiCredentials(accountId, apiToken);
      models = await new WorkersAiApi(credentials).listModels();
    } catch (error) {
      if (error instanceof WorkersAiApiError) {
        logger.warn("Workers AI credential validation failed", {
          event: "credentials.validation.failed",
          status: error.status,
          codes: error.codes,
        });
      }
      return { kind: "error", message: error instanceof Error ? error.message : "Unable to validate credentials." };
    }

    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.put("credentials", credentials);
    this.ctx.storage.kv.put<StoredCatalog>("catalog", {
      version: CATALOG_CACHE_VERSION,
      models,
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
    });
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Connection callback expired. Please try again." };
    }

    try {
      if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
        this.ctx.storage.kv.delete("reconnecting");
        await callback.credentialsRestored();
      } else {
        await callback.complete(this.ctx.exports.WorkersAiUser({
          props: { userObjectId: this.ctx.id.toString() },
        }));
      }
    } catch (error) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: error instanceof Error ? error.message : "Unable to save connection." };
    }
    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): WorkersAiCredentials {
    const credentials = this.ctx.storage.kv.get<WorkersAiCredentials>("credentials");
    if (!credentials) throw new Error("Workers AI credentials are not configured.");
    return credentials;
  }

  async listModels(task?: WorkersAiTask): Promise<WorkersAiModelInfo[]> {
    const cached = this.ctx.storage.kv.get<StoredCatalog>("catalog");
    let models: WorkersAiModelInfo[];
    if (cached?.version === CATALOG_CACHE_VERSION && cached.expiresAt > Date.now()) {
      models = cached.models;
    } else {
      try {
        models = await new WorkersAiApi(this.getCredentials()).listModels();
        this.ctx.storage.kv.put<StoredCatalog>("catalog", {
          version: CATALOG_CACHE_VERSION,
          models,
          expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
        });
      } catch (error) {
        await this.#noteAuthFailure(error);
        throw error;
      }
    }
    return task ? models.filter(model => model.task === task) : models;
  }

  async getModel(modelId: string): Promise<WorkersAiModelInfo> {
    const normalized = normalizeWorkersAiModelId(modelId);
    const model = (await this.listModels()).find(candidate => candidate.id === normalized);
    if (!model) throw new Error("This model is not available to the connected Workers AI account.");
    return model;
  }

  async getInputFields(modelId: string): Promise<string[]> {
    const normalized = normalizeWorkersAiModelId(modelId);
    const key = `schema:${normalized}`;
    const cached = this.ctx.storage.kv.get<StoredSchemaFields>(key);
    if (cached && cached.expiresAt > Date.now()) return cached.fields;
    try {
      const fields = [...await new WorkersAiApi(this.getCredentials()).getInputFields(normalized)];
      this.ctx.storage.kv.put<StoredSchemaFields>(key, {
        fields,
        expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS,
      });
      return fields;
    } catch (error) {
      await this.#noteAuthFailure(error);
      throw error;
    }
  }

  async #noteAuthFailure(error: unknown): Promise<void> {
    if (!(error instanceof WorkersAiApiError) || !error.isAuthError) return;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    await callback?.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<WorkersAiCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type WorkersAiUserProps = { userObjectId: string };

/** Connected Workers AI account exposed to the Workshop. */
@validateRpc()
export class WorkersAiUser extends WorkerEntrypoint<Env, WorkersAiUserProps>
    implements WorkersAiGatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async describe(): Promise<AccountDescription> {
    const credentials = await this.#account().getCredentials();
    return {
      displayName: "Cloudflare Workers AI",
      uniqueName: credentials.accountId,
      avatar: CLOUDFLARE_LOGO,
    };
  }

  async listModels(task?: WorkersAiTask): Promise<WorkersAiModelInfo[]> {
    return this.#account().listModels(task);
  }

  async getWorkersAiCredentials(): Promise<WorkersAiCredentials> {
    return this.#account().getCredentials();
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [modelResource(this.env)];
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const resource = modelResource(this.env);
    if (resourceUrlPattern !== resource.urlPattern) {
      throw new Error(`Unsupported Workers AI resource type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: MODEL_CONFIGURATOR_HTML,
      ui: new RpcStub(new WorkersAiModelConfigurator(this.#account(), this.env)),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const modelId = parseResourceUrl(this.env, url);
    const account = this.#account();
    const model = await account.getModel(modelId);
    if (model.task === "text-generation") {
      throw new Error("Text-generation models are added from Providers, not bound as a Gadget resource.");
    }
    const inputFields = await account.getInputFields(model.id);
    const props: WorkersAiGatekeeperProps = {
      userObjectId: this.ctx.props.userObjectId,
      modelId: model.id,
      modelName: model.name,
      task: model.task,
      inputFields,
      resourceUrl: resourceUrl(this.env, model.id),
    };
    const resource = modelResource(this.env);
    switch (model.task) {
      case "text-embeddings":
        return { class: this.ctx.exports.WorkersAiEmbeddingsGatekeeper({ props }), resource };
      case "text-to-image":
        return { class: this.ctx.exports.WorkersAiImageGenerationGatekeeper({ props }), resource };
      case "automatic-speech-recognition":
        return { class: this.ctx.exports.WorkersAiSpeechRecognitionGatekeeper({ props }), resource };
      case "text-to-speech":
        return { class: this.ctx.exports.WorkersAiTextToSpeechGatekeeper({ props }), resource };
      case "text-classification":
        return { class: this.ctx.exports.WorkersAiClassificationGatekeeper({ props }), resource };
    }
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#account().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${CONNECT_PATH}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WorkersAiVerifier({});
  }
}

/** Trivial verifier object required by the private-only observer strategy. */
@validateRpc()
export class WorkersAiVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/** Narrow helper exposed only to the sandboxed model-selection iframe. */
@validateRpc()
class WorkersAiModelConfigurator extends RpcTarget implements WorkersAiModelConfiguratorRpc {
  readonly #account: DurableObjectStub<UserAccount>;
  readonly #env: Env;

  constructor(account: DurableObjectStub<UserAccount>, env: Env) {
    super();
    this.#account = account;
    this.#env = env;
  }

  async listModels(query: string): Promise<Array<{
    value: string;
    title: string;
    subtitle?: string;
    meta?: string;
  }>> {
    const normalizedQuery = query.trim().toLowerCase();
    return (await this.#account.listModels())
      .filter(model => model.task !== "text-generation")
      .filter(model => !normalizedQuery ||
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.task.includes(normalizedQuery))
      .slice(0, 100)
      .map(model => ({
        value: model.id,
        title: model.name,
        subtitle: TASK_DETAILS[model.task as Exclude<WorkersAiTask, "text-generation">].title,
        meta: model.id,
      }));
  }

  async resourceUrl(modelId: string | null | undefined): Promise<string> {
    if (!modelId) throw new Error("Choose a Workers AI model.");
    const model = await this.#account.getModel(modelId);
    if (model.task === "text-generation") {
      throw new Error("Choose a non-chat Workers AI model for this connection.");
    }
    return resourceUrl(this.#env, model.id);
  }
}

type NonChatWorkersAiTask = Exclude<WorkersAiTask, "text-generation">;
type WorkersAiGatekeeperProps = {
  userObjectId: string;
  modelId: string;
  modelName: string;
  task: NonChatWorkersAiTask;
  inputFields: string[];
  resourceUrl: string;
};

abstract class WorkersAiGatekeeperBase<Session> extends DurableObject<Env, WorkersAiGatekeeperProps>
    implements Gatekeeper<Session> {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  protected async api(): Promise<WorkersAiApi> {
    return new WorkersAiApi(await this.#account().getCredentials());
  }

  async describe(): Promise<ResourceDescription> {
    const details = TASK_DETAILS[this.ctx.props.task];
    return {
      url: this.ctx.props.resourceUrl,
      title: this.ctx.props.modelName,
      snippet: details.snippet,
      suggestedBindingName: details.bindingName,
      tsType: details.tsType,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  abstract startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session>;

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // Model calls transmit Gadget data and spend the account owner's Workers AI allowance. Until a
    // binding can route each observer through their own account, sharing this capability is unsafe.
    throw new Error("Workers AI model bindings are private and cannot be shared with collaborators.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_action: number): Promise<void> {
    throw new Error("Workers AI inference has no queued actions.");
  }

  async rejectAction(_action: number): Promise<void> {
    throw new Error("Workers AI inference has no queued actions.");
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("Workers AI inference has no queued actions.");
  }
}

/** Per-model embeddings capability. */
@validateRpc()
export class WorkersAiEmbeddingsGatekeeper
    extends WorkersAiGatekeeperBase<WorkersAiEmbeddingsSession> {
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WorkersAiEmbeddingsSession> {
    return new WorkersAiEmbeddingsSessionImpl(
      queue.dup(), await this.api(), this.ctx.props.modelId, this.ctx.props.inputFields,
    );
  }
}

/** Per-model image-generation capability. */
@validateRpc()
export class WorkersAiImageGenerationGatekeeper
    extends WorkersAiGatekeeperBase<WorkersAiImageGenerationSession> {
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WorkersAiImageGenerationSession> {
    return new WorkersAiImageGenerationSessionImpl(
      queue.dup(), await this.api(), this.ctx.props.modelId, this.ctx.props.inputFields,
    );
  }
}

/** Per-model speech-recognition capability. */
@validateRpc()
export class WorkersAiSpeechRecognitionGatekeeper
    extends WorkersAiGatekeeperBase<WorkersAiSpeechRecognitionSession> {
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WorkersAiSpeechRecognitionSession> {
    return new WorkersAiSpeechRecognitionSessionImpl(
      queue.dup(), await this.api(), this.ctx.props.modelId, this.ctx.props.inputFields,
    );
  }
}

/** Per-model text-to-speech capability. */
@validateRpc()
export class WorkersAiTextToSpeechGatekeeper
    extends WorkersAiGatekeeperBase<WorkersAiTextToSpeechSession> {
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WorkersAiTextToSpeechSession> {
    return new WorkersAiTextToSpeechSessionImpl(
      queue.dup(), await this.api(), this.ctx.props.modelId, this.ctx.props.inputFields,
    );
  }
}

/** Per-model text-classification capability. */
@validateRpc()
export class WorkersAiClassificationGatekeeper
    extends WorkersAiGatekeeperBase<WorkersAiClassificationSession> {
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WorkersAiClassificationSession> {
    return new WorkersAiClassificationSessionImpl(
      queue.dup(), await this.api(), this.ctx.props.modelId, this.ctx.props.inputFields,
    );
  }
}
