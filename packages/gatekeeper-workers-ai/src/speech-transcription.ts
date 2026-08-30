import type {
  WorkersAiTranscript,
  WorkersAiTranscriptWord,
  WorkersAiTranscriptionOptions,
} from "./types";
import type { WorkersAiModelInfo } from "@gadgets/workshop-shared/workers-ai-gatekeeper";

/** Maximum source audio accepted before JSON-array expansion inside a Worker. */
export const MAX_WORKERS_AI_AUDIO_BYTES = 5 * 1024 * 1024;
const DEFAULT_SPEECH_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";
const FALLBACK_SPEECH_MODEL_ID = "@cf/openai/whisper";

type JsonRecord = Record<string, unknown>;

type WorkersAiJsonRunner = {
  runJson(modelId: string, input: JsonRecord): Promise<unknown>;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredLanguage(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Language must not be empty.");
  if (normalized.length > 100) throw new Error("Language is too long.");
  return normalized;
}

function transcriptWords(value: unknown): WorkersAiTranscriptWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words: WorkersAiTranscriptWord[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const text = typeof record.word === "string" ? record.word :
      typeof record.text === "string" ? record.text : undefined;
    const start = finiteNumber(record.start) ?? finiteNumber(record.start_seconds);
    const end = finiteNumber(record.end) ?? finiteNumber(record.end_seconds);
    if (text !== undefined && start !== undefined && end !== undefined) {
      words.push({ text, startSeconds: start, endSeconds: end });
    }
  }
  return words.length > 0 ? words : undefined;
}

function transcriptFromUnknown(value: unknown): WorkersAiTranscript {
  const root = asRecord(value);
  const info = asRecord(root?.transcription_info) ?? asRecord(root?.results) ?? root;
  if (!info || typeof info.text !== "string") {
    throw new Error("Workers AI returned an invalid transcription.");
  }
  const words = transcriptWords(info.words) ?? transcriptWords(info.segments);
  const language = typeof info.language === "string" ? info.language : undefined;
  const durationSeconds = finiteNumber(info.duration) ?? finiteNumber(info.duration_seconds);
  return { text: info.text, language, durationSeconds, words };
}

/** Selects the preferred non-deprecated speech model from an account-scoped ASR catalog. */
export function selectWorkersAiSpeechModel(
  models: readonly WorkersAiModelInfo[],
): WorkersAiModelInfo | undefined {
  return models.find(candidate => candidate.id === DEFAULT_SPEECH_MODEL_ID) ??
    models.find(candidate => candidate.id === FALLBACK_SPEECH_MODEL_ID) ??
    models.find(candidate => !candidate.deprecated) ?? models[0];
}

/** Rejects empty or oversized source audio before any approval or provider request. */
export function validateWorkersAiSpeechAudio(audio: Blob): void {
  if (audio.size <= 0 || audio.size > MAX_WORKERS_AI_AUDIO_BYTES) {
    throw new Error(`Audio must be between 1 byte and ${MAX_WORKERS_AI_AUDIO_BYTES} bytes.`);
  }
}

/**
 * Transcribes one bounded audio clip without applying an approval policy. Callers must authorize
 * the operation before invoking this helper.
 */
export async function transcribeWorkersAiAudio(
  api: WorkersAiJsonRunner,
  modelId: string,
  inputFields: ReadonlySet<string>,
  audio: Blob,
  options: WorkersAiTranscriptionOptions = {},
): Promise<WorkersAiTranscript> {
  validateWorkersAiSpeechAudio(audio);

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const payload: JsonRecord = { audio: [...bytes] };
  if (options.language) {
    const language = requiredLanguage(options.language);
    payload[inputFields.has("source_lang") ? "source_lang" : "language"] = language;
  }
  if (options.wordTimestamps && inputFields.has("word_timestamps")) {
    payload.word_timestamps = true;
  }
  return transcriptFromUnknown(await api.runJson(modelId, payload));
}
