/** One text-embedding operation's normalized result. */
export type WorkersAiEmbeddingResult = {
  /** One vector per input string, in the same order as the input. */
  vectors: number[][];

  /** Number of numeric values in each vector. Zero when no vector was returned. */
  dimensions: number;
};

/** Access to one bound Workers AI text-embedding model. */
export interface WorkersAiEmbeddingsSession {
  /** Generate vectors for one or more non-empty strings. */
  embed(input: string | string[]): Promise<WorkersAiEmbeddingResult>;
}

/** Portable options supported by Workers AI text-to-image models. */
export type WorkersAiImageOptions = {
  /** Description of content that should be avoided in the generated image. */
  negativePrompt?: string;

  /** Requested image width. The selected model may reject unsupported dimensions. */
  width?: number;

  /** Requested image height. The selected model may reject unsupported dimensions. */
  height?: number;

  /** Random seed used to make a generation reproducible. */
  seed?: number;

  /** Number of generation steps. The selected model may impose a smaller limit. */
  steps?: number;
};

/** One image returned by a Workers AI image-generation model. */
export type WorkersAiGeneratedImage = {
  /** Generated image bytes. Read the MIME type from `data.type`. */
  data: Blob;

  /** Seed reported by the model, when available. */
  seed?: number;
};

/** Access to one bound Workers AI text-to-image model. */
export interface WorkersAiImageGenerationSession {
  /** Generate an image from a non-empty text prompt. */
  generate(prompt: string, options?: WorkersAiImageOptions): Promise<WorkersAiGeneratedImage>;
}

/** Timing information for one recognized word or text segment. */
export type WorkersAiTranscriptWord = {
  /** Recognized word or segment text. */
  text: string;

  /** Start time relative to the beginning of the audio, in seconds. */
  startSeconds: number;

  /** End time relative to the beginning of the audio, in seconds. */
  endSeconds: number;
};

/** Normalized output from a speech-recognition model. */
export type WorkersAiTranscript = {
  /** Complete transcription text. */
  text: string;

  /** Detected or requested language code, when reported. */
  language?: string;

  /** Audio duration in seconds, when reported. */
  durationSeconds?: number;

  /** Word- or segment-level timing, when supported by the selected model. */
  words?: WorkersAiTranscriptWord[];
};

/** Portable speech-recognition options. */
export type WorkersAiTranscriptionOptions = {
  /** Audio language code. Omit it to let the selected model detect the language. */
  language?: string;

  /** Request word- or segment-level timing when the selected model supports it. */
  wordTimestamps?: boolean;
};

/** Access to one bound Workers AI automatic-speech-recognition model. */
export interface WorkersAiSpeechRecognitionSession {
  /** Transcribe a non-empty audio Blob. */
  transcribe(audio: Blob, options?: WorkersAiTranscriptionOptions): Promise<WorkersAiTranscript>;
}

/** Portable options supported by Workers AI text-to-speech models. */
export type WorkersAiSpeechOptions = {
  /** Voice or speaker name supported by the selected model. */
  voice?: string;

  /** Language code for the synthesized speech. */
  language?: string;

  /** Speech-speed multiplier. The selected model may reject unsupported values. */
  speed?: number;
};

/** Access to one bound Workers AI text-to-speech model. */
export interface WorkersAiTextToSpeechSession {
  /** Synthesize a non-empty string into audio. Read the MIME type from the returned Blob. */
  synthesize(text: string, options?: WorkersAiSpeechOptions): Promise<Blob>;
}

/** One label returned by a Workers AI text-classification model. */
export type WorkersAiClassificationResult = {
  /** Classification label. */
  label: string;

  /** Confidence or relevance score reported by the selected model. */
  score: number;
};

/** Access to one bound Workers AI text-classification model. */
export interface WorkersAiClassificationSession {
  /** Classify a non-empty string, ordered from highest to lowest score. */
  classify(text: string): Promise<WorkersAiClassificationResult[]>;
}
