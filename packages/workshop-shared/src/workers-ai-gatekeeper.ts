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

/** One word or text segment reported by a Workers AI speech-recognition model. */
export type WorkersAiSpeechTiming = {
  /** Recognized text for this timing range. */
  text: string;

  /** Start time relative to the beginning of the audio, in seconds. */
  startSeconds: number;

  /** End time relative to the beginning of the audio, in seconds. */
  endSeconds: number;
};

/** Portable options for one account-scoped Workers AI speech transcription. */
export type WorkersAiSpeechOptions = {
  /** Exact account-visible ASR model to use. Omit it to select the preferred model. */
  modelId?: string;

  /** Audio language code. Omit it to let the model detect the language. */
  language?: string;

  /** Request word- or segment-level timing when the model supports it. */
  wordTimestamps?: boolean;
};

/** Transcription returned by a Workers AI speech-recognition model. */
export type WorkersAiSpeechTranscription = {
  /** Complete recognized text. */
  text: string;

  /** Detected or requested language code, when reported by the model. */
  language?: string;

  /** Audio duration in seconds, when reported by the model. */
  durationSeconds?: number;

  /** Exact Workers AI model used for this transcription. */
  modelId: string;

  /** Word- or segment-level timing, when supported by the selected model. */
  words?: WorkersAiSpeechTiming[];
};

/** Workshop-only extension implemented by the Workers AI connected account. */
export interface WorkersAiGatekeeperUser extends GatekeeperUser {
  /**
   * Lists active models visible to this account, optionally restricted to one supported task.
   * Credentials and account identifiers are never included.
   */
  listModels(task?: WorkersAiTask): Promise<WorkersAiModelInfo[]>;

  /**
   * Transcribes one short audio clip with an available automatic-speech-recognition model.
   * The connected credentials remain private to the gatekeeper.
   */
  transcribeSpeech(
    audio: Blob,
    options?: WorkersAiSpeechOptions,
  ): Promise<WorkersAiSpeechTranscription>;

  /**
   * Returns the connected Account ID and API Token for trusted Workshop inference routing.
   * Workshop-only — never expose the result through an authenticated client or agent API.
   */
  getWorkersAiCredentials(): Promise<WorkersAiCredentials>;
}
