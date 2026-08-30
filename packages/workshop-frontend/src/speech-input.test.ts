import { describe, expect, it } from "vitest";
import {
  insertSpeechTranscript,
  preferredSpeechRecordingMimeType,
} from "./speech-input";

describe("speech input", () => {
  it("inserts a transcript at the caret and separates adjacent Latin words", () => {
    expect(insertSpeechTranscript("hello world", "new text", 5)).toEqual({
      value: "hello new text world",
      caret: 14,
    });
  });

  it("does not add Western spaces around Chinese text", () => {
    expect(insertSpeechTranscript("你好世界", "，这是语音输入", 2)).toEqual({
      value: "你好，这是语音输入世界",
      caret: 9,
    });
  });

  it("selects the first supported compressed recording format", () => {
    expect(preferredSpeechRecordingMimeType(type => type === "audio/mp4")).toBe("audio/mp4");
    expect(preferredSpeechRecordingMimeType(() => false)).toBe("");
  });
});
