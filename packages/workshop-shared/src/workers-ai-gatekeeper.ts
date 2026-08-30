// Workers-AI-gatekeeper-specific extension to the generic GatekeeperUser contract. The Workshop
// narrows a connected account stub to this interface for model discovery and chat inference setup;
// none of these methods are exposed to gadgets or agents.

import { GatekeeperUser } from "./gatekeeper.js";

/** Workers AI tasks that CinaSeek currently exposes through typed capabilities. */
export type WorkersAiTask =
  | "text-generation"
  | "text-embeddings"
  | "text-to-image"
  | "automatic-speech-recognition"
  | "text-to-speech"
  | "text-classification";

/** Safe, non-secret metadata for one model visible to the connected Cloudflare account. */
export type WorkersAiModelInfo = {
  /** Exact model identifier accepted by the Workers AI inference endpoint. */
  id: string;

  /** Human-readable model name. */
  name: string;

  /** Normalized Workers AI task implemented by the model. */
  task: WorkersAiTask;

  /** Short provider description, when Cloudflare supplies one. */
  description?: string;

  /** Whether Cloudflare marks the model deprecated. */
  deprecated?: boolean;

  /** Whether Cloudflare marks the model experimental or beta. */
  experimental?: boolean;
};

/** Secret credentials for one user-owned Workers AI connection. */
export type WorkersAiCredentials = {
  /** Cloudflare account that is billed for inference. */
  accountId: string;

  /** API token authorized for Workers AI on that account. */
  apiToken: string;
};

/** Workshop-only extension implemented by the Workers AI connected account. */
export interface WorkersAiGatekeeperUser extends GatekeeperUser {
  /**
   * Lists active models visible to this account, optionally restricted to one supported task.
   * Credentials and account identifiers are never included.
   */
  listModels(task?: WorkersAiTask): Promise<WorkersAiModelInfo[]>;

  /**
   * Returns the connected Account ID and API Token for trusted Workshop inference routing.
   * Workshop-only — never expose the result through an authenticated client or agent API.
   */
  getWorkersAiCredentials(): Promise<WorkersAiCredentials>;
}
