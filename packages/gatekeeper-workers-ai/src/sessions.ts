import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type {
  WorkersAiClassificationResult,
  WorkersAiClassificationSession,
  WorkersAiEmbeddingResult,
  WorkersAiEmbeddingsSession,
  WorkersAiGeneratedImage,
  WorkersAiImageGenerationSession,
  WorkersAiImageOptions,
  WorkersAiSpeechOptions,
  WorkersAiSpeechRecognitionSession,
  WorkersAiTextToSpeechSession,
  WorkersAiTranscript,
  WorkersAiTranscriptWord,
  WorkersAiTranscriptionOptions,
} from "./types";
import { WorkersAiApi, unwrapWorkersAiJsonResponse } from "./workers-ai-api.js";

const MAX_TEXT_LENGTH = 100_000;
const MAX_EMBEDDING_INPUTS = 100;
// Workers AI's REST shape requires audio as a JSON number array. Keep the source bounded so the
// expanded number array plus its serialized body remains within a Worker's memory ceiling.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} is too long.`);
  }
  return normalized;
}

function optionalInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalFinite(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function vectorsFromUnknown(value: unknown): number[][] {
  const record = asRecord(value);
  const candidate = record?.data ?? record?.embeddings ?? value;
  if (!Array.isArray(candidate)) throw new Error("Workers AI returned invalid embedding data.");
  const vectors: number[][] = [];
  for (const row of candidate) {
    const rowRecord = asRecord(row);
    const values = rowRecord?.embedding ?? rowRecord?.values ?? row;
    if (!Array.isArray(values) || values.some(item => typeof item !== "number" || !Number.isFinite(item))) {
      throw new Error("Workers AI returned an invalid embedding vector.");
    }
    vectors.push(values as number[]);
  }
  if (vectors.length > 1 && vectors.some(vector => vector.length !== vectors[0].length)) {
    throw new Error("Workers AI returned embedding vectors with inconsistent dimensions.");
  }
  return vectors;
}

function decodeBase64(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const encoded = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("Workers AI returned invalid base64 media data.");
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function base64MediaFromUnknown(value: unknown, keys: string[], fallbackType: string): Blob {
  const record = asRecord(value);
  let candidate: unknown = value;
  if (record) {
    for (const key of keys) {
      if (typeof record[key] === "string") {
        candidate = record[key];
        break;
      }
    }
  }
  if (typeof candidate !== "string") {
    throw new Error("Workers AI returned invalid media data.");
  }
  const mimeMatch = /^data:([^;,]+)[;,]/.exec(candidate);
  return new Blob([decodeBase64(candidate)], { type: mimeMatch?.[1] ?? fallbackType });
}

async function mediaFromResponse(
  response: Response,
  keys: string[],
  fallbackType: string,
): Promise<{ data: Blob; json?: unknown }> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
    return { data: new Blob([await response.arrayBuffer()], { type: contentType }) };
  }
  const json = await unwrapWorkersAiJsonResponse(response);
  return { data: base64MediaFromUnknown(json, keys, fallbackType), json };
}

abstract class WorkersAiSessionBase extends RpcTarget {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  protected readonly api: WorkersAiApi;
  protected readonly modelId: string;
  protected readonly inputFields: ReadonlySet<string>;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    api: WorkersAiApi,
    modelId: string,
    inputFields: string[],
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.api = api;
    this.modelId = modelId;
    this.inputFields = new Set(inputFields);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  protected async authorize(title: string, description: string): Promise<void> {
    // Authorize before sending caller content to the provider. Descriptions deliberately include
    // only model identifiers and bounded sizes, never prompts, transcripts, or generated media.
    await this.#approvalQueue.authorizeObservation({ title, description });
  }
}

/** RPC implementation for one model-scoped embeddings capability. */
@validateRpc()
export class WorkersAiEmbeddingsSessionImpl extends WorkersAiSessionBase
    implements WorkersAiEmbeddingsSession {
  async embed(input: string | string[]): Promise<WorkersAiEmbeddingResult> {
    const inputs = (Array.isArray(input) ? input : [input]).map(value => requiredText(value, "Input"));
    if (inputs.length === 0 || inputs.length > MAX_EMBEDDING_INPUTS) {
      throw new Error(`Embedding input must contain between 1 and ${MAX_EMBEDDING_INPUTS} texts.`);
    }
    await this.authorize(
      "Generate Workers AI embeddings",
      `Model ${this.modelId}; ${inputs.length} text input${inputs.length === 1 ? "" : "s"}.`,
    );
    const output = await this.api.runJson(this.modelId, {
      text: Array.isArray(input) ? inputs : inputs[0],
    });
    const vectors = vectorsFromUnknown(output);
    if (vectors.length !== inputs.length) {
      throw new Error("Workers AI returned a different number of vectors than inputs.");
    }
    return { vectors, dimensions: vectors[0]?.length ?? 0 };
  }
}

/** RPC implementation for one model-scoped text-to-image capability. */
@validateRpc()
export class WorkersAiImageGenerationSessionImpl extends WorkersAiSessionBase
    implements WorkersAiImageGenerationSession {
  async generate(
    prompt: string,
    options: WorkersAiImageOptions = {},
  ): Promise<WorkersAiGeneratedImage> {
    const normalizedPrompt = requiredText(prompt, "Prompt");
    const payload: JsonRecord = { prompt: normalizedPrompt };
    if (options.negativePrompt !== undefined) {
      payload.negative_prompt = requiredText(options.negativePrompt, "Negative prompt");
    }
    const width = optionalInteger(options.width, "Width");
    const height = optionalInteger(options.height, "Height");
    const seed = optionalInteger(options.seed, "Seed");
    const steps = optionalInteger(options.steps, "Steps");
    if (width !== undefined) payload.width = width;
    if (height !== undefined) payload.height = height;
    if (seed !== undefined) payload.seed = seed;
    if (steps !== undefined) {
      payload[this.inputFields.has("steps") ? "steps" : "num_steps"] = steps;
    }

    await this.authorize(
      "Generate a Workers AI image",
      `Model ${this.modelId}; prompt length ${normalizedPrompt.length} characters.`,
    );
    const response = await this.api.run(this.modelId, JSON.stringify(payload), "application/json");
    const output = await mediaFromResponse(response, ["image", "image_b64", "data"], "image/png");
    const outputRecord = asRecord(output.json);
    return { data: output.data, seed: finiteNumber(outputRecord?.seed) };
  }
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
  return {
    text: info.text,
    language,
    durationSeconds,
    words,
  };
}

/** RPC implementation for one model-scoped speech-recognition capability. */
@validateRpc()
export class WorkersAiSpeechRecognitionSessionImpl extends WorkersAiSessionBase
    implements WorkersAiSpeechRecognitionSession {
  async transcribe(
    audio: Blob,
    options: WorkersAiTranscriptionOptions = {},
  ): Promise<WorkersAiTranscript> {
    if (audio.size <= 0 || audio.size > MAX_AUDIO_BYTES) {
      throw new Error(`Audio must be between 1 byte and ${MAX_AUDIO_BYTES} bytes.`);
    }
    await this.authorize(
      "Transcribe audio with Workers AI",
      `Model ${this.modelId}; audio size ${audio.size} bytes; MIME type ${audio.type || "unknown"}.`,
    );

    const bytes = new Uint8Array(await audio.arrayBuffer());
    const payload: JsonRecord = { audio: [...bytes] };
    if (options.language) {
      const language = requiredText(options.language, "Language");
      payload[this.inputFields.has("source_lang") ? "source_lang" : "language"] = language;
    }
    if (options.wordTimestamps && this.inputFields.has("word_timestamps")) {
      payload.word_timestamps = true;
    }
    return transcriptFromUnknown(await this.api.runJson(this.modelId, payload));
  }
}

/** RPC implementation for one model-scoped text-to-speech capability. */
@validateRpc()
export class WorkersAiTextToSpeechSessionImpl extends WorkersAiSessionBase
    implements WorkersAiTextToSpeechSession {
  async synthesize(text: string, options: WorkersAiSpeechOptions = {}): Promise<Blob> {
    const normalizedText = requiredText(text, "Text");
    const textField = this.inputFields.has("text") ? "text" : "prompt";
    const payload: JsonRecord = { [textField]: normalizedText };
    if (options.voice) {
      payload[this.inputFields.has("speaker") ? "speaker" : "voice"] =
        requiredText(options.voice, "Voice");
    }
    if (options.language) {
      payload[this.inputFields.has("lang") ? "lang" : "language"] =
        requiredText(options.language, "Language");
    }
    const speed = optionalFinite(options.speed, "Speed");
    if (speed !== undefined) payload.speed = speed;

    await this.authorize(
      "Synthesize speech with Workers AI",
      `Model ${this.modelId}; text length ${normalizedText.length} characters.`,
    );
    const response = await this.api.run(this.modelId, JSON.stringify(payload), "application/json");
    return (await mediaFromResponse(response, ["audio", "audio_b64", "data"], "audio/mpeg")).data;
  }
}

function classificationsFromUnknown(value: unknown): WorkersAiClassificationResult[] {
  const record = asRecord(value);
  const candidate = record?.data ?? record?.results ?? value;
  if (!Array.isArray(candidate)) {
    throw new Error("Workers AI returned invalid classification data.");
  }
  const result: WorkersAiClassificationResult[] = [];
  for (const entry of candidate) {
    const item = asRecord(entry);
    if (!item) continue;
    const label = typeof item.label === "string" ? item.label :
      typeof item.name === "string" ? item.name : undefined;
    const score = finiteNumber(item.score) ?? finiteNumber(item.confidence);
    if (label !== undefined && score !== undefined) result.push({ label, score });
  }
  if (result.length === 0) throw new Error("Workers AI returned no classification results.");
  return result.toSorted((a, b) => b.score - a.score);
}

/** RPC implementation for one model-scoped text-classification capability. */
@validateRpc()
export class WorkersAiClassificationSessionImpl extends WorkersAiSessionBase
    implements WorkersAiClassificationSession {
  async classify(text: string): Promise<WorkersAiClassificationResult[]> {
    const normalizedText = requiredText(text, "Text");
    await this.authorize(
      "Classify text with Workers AI",
      `Model ${this.modelId}; text length ${normalizedText.length} characters.`,
    );
    return classificationsFromUnknown(await this.api.runJson(this.modelId, { text: normalizedText }));
  }
}
