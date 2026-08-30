// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { useSpeechInput, type SpeechInputError } from "./speech-input";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class TestMediaRecorder extends EventTarget {
  static isTypeSupported(mimeType: string): boolean {
    return mimeType === "audio/webm;codecs=opus";
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const dataEvent = new Event("dataavailable");
    Object.defineProperty(dataEvent, "data", {
      value: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

const originalMediaRecorder = globalThis.MediaRecorder;
const originalMediaDevices = navigator.mediaDevices;

afterEach(() => {
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: originalMediaRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  document.body.replaceChildren();
});

describe("useSpeechInput", () => {
  it("records, transcribes, and returns text without sending it", async () => {
    const stopTrack = vi.fn<() => void>();
    const getUserMedia = vi.fn<() => Promise<MediaStream>>(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream));
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const transcribeSpeech = vi.fn<AuthenticatedApi["transcribeSpeech"]>(async () => ({
      text: "语音输入",
      modelId: "@cf/openai/whisper-large-v3-turbo",
    }));
    const api = {
      listWorkersAiCatalog: vi.fn<AuthenticatedApi["listWorkersAiCatalog"]>(async () => [{
        id: "@cf/openai/whisper-large-v3-turbo",
        name: "Whisper Large V3 Turbo",
        task: "automatic-speech-recognition" as const,
      }]),
      transcribeSpeech,
    } satisfies Pick<AuthenticatedApi, "listWorkersAiCatalog" | "transcribeSpeech">;
    const transcripts: string[] = [];
    const errors: SpeechInputError[] = [];

    function Probe() {
      const speech = useSpeechInput({
        authenticatedApi: api,
        onTranscript: text => transcripts.push(text),
        onError: error => errors.push(error),
      });
      return (
        <button data-status={speech.status} onClick={() => void speech.toggleRecording()}>
          toggle
        </button>
      );
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    const button = container.querySelector("button")!;
    expect(button.dataset.status).toBe("idle");

    await act(async () => {
      button.click();
    });
    expect(button.dataset.status).toBe("recording");

    await act(async () => {
      button.click();
    });
    expect(transcribeSpeech).toHaveBeenCalledOnce();
    expect(transcripts).toEqual(["语音输入"]);
    expect(errors).toEqual([]);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(button.dataset.status).toBe("idle");

    await act(async () => root.unmount());
  });
});
