import { describe, expect, it, vi } from "vitest";
import {
  selectWorkersAiSpeechModel,
  transcribeWorkersAiAudio,
} from "../src/speech-transcription.js";

describe("Workers AI speech transcription", () => {
  it("prefers Whisper Large V3 Turbo and skips deprecated fallbacks", () => {
    const models = [
      { id: "@cf/example/deprecated", name: "Old", task: "automatic-speech-recognition" as const, deprecated: true },
      { id: "@cf/openai/whisper", name: "Whisper", task: "automatic-speech-recognition" as const },
      { id: "@cf/openai/whisper-large-v3-turbo", name: "Whisper Turbo", task: "automatic-speech-recognition" as const },
    ];
    expect(selectWorkersAiSpeechModel(models)?.id).toBe(
      "@cf/openai/whisper-large-v3-turbo",
    );
  });

  it("normalizes audio bytes and a language field", async () => {
    const runJson = vi.fn(async () => ({
      transcription_info: { text: "你好", language: "zh", duration: 1.25 },
    }));
    const transcript = await transcribeWorkersAiAudio(
      { runJson },
      "@cf/openai/whisper-large-v3-turbo",
      new Set(["audio", "language"]),
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      { language: "zh" },
    );

    expect(runJson).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", {
      audio: [1, 2, 3],
      language: "zh",
    });
    expect(transcript).toEqual({
      text: "你好",
      language: "zh",
      durationSeconds: 1.25,
      words: undefined,
    });
  });

  it("rejects empty and oversized audio before inference", async () => {
    const runner = { runJson: vi.fn(async () => ({})) };
    await expect(transcribeWorkersAiAudio(
      runner, "@cf/openai/whisper", new Set(), new Blob([]),
    )).rejects.toThrow("between 1 byte");
    await expect(transcribeWorkersAiAudio(
      runner,
      "@cf/openai/whisper",
      new Set(),
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]),
    )).rejects.toThrow("between 1 byte");
    expect(runner.runJson).not.toHaveBeenCalled();
  });
});
