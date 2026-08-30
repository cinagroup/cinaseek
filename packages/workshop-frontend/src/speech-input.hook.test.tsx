// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedApi, WorkersAiSpeechSettings } from "@gadgets/workshop-shared/api";
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
      access: "private",
    }));
    const settings: WorkersAiSpeechSettings = {
      modelId: "@cf/openai/whisper-large-v3-turbo",
      language: null,
      shareWithUsers: false,
      models: [{
        id: "@cf/openai/whisper-large-v3-turbo",
        name: "Whisper Large V3 Turbo",
        access: "private",
        shareable: true,
        poolSize: 0,
        availableCredentials: 0,
      }],
      sharedSecondsUsed: 0,
      sharedSecondsLimit: 1_800,
      sharedRequestsUsed: 0,
      sharedRequestsLimit: 120,
      quotaResetAt: "2026-08-31T00:00:00.000Z",
    };
    const api = {
      getWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["getWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      updateWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["updateWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      transcribeSpeech,
    } satisfies Pick<
      AuthenticatedApi,
      "getWorkersAiSpeechSettings" | "updateWorkersAiSpeechSettings" | "transcribeSpeech"
    >;
    const transcripts: string[] = [];
    const errors: SpeechInputError[] = [];

    function Probe() {
      const speech = useSpeechInput({
        authenticatedApi: api,
        onTranscript: text => transcripts.push(text),
        onError: error => errors.push(error),
      });
      return (
        <>
          <button
            data-status={speech.status}
            data-can-retry={String(speech.canRetry)}
            onClick={() => void speech.toggleRecording()}
          >
            toggle
          </button>
          <button data-retry onClick={() => void speech.retryTranscription()}>retry</button>
        </>
      );
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    const button = container.querySelector<HTMLButtonElement>("button:not([data-retry])")!;
    expect(button.dataset.status).toBe("idle");

    await act(async () => {
      button.click();
    });
    expect(button.dataset.status).toBe("recording");

    await act(async () => {
      button.click();
    });
    expect(transcribeSpeech).toHaveBeenCalledOnce();
    expect(transcribeSpeech.mock.calls[0]?.[1]).toMatchObject({
      wordTimestamps: true,
    });
    expect(transcribeSpeech.mock.calls[0]?.[1].durationSeconds).toBeGreaterThan(0);
    expect(transcripts).toEqual(["语音输入"]);
    expect(errors).toEqual([]);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(button.dataset.status).toBe("idle");
    expect(button.dataset.canRetry).toBe("true");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-retry]")!.click();
    });
    expect(transcribeSpeech).toHaveBeenCalledTimes(2);
    expect(transcripts).toEqual(["语音输入", "语音输入"]);

    await act(async () => root.unmount());
  });

  it("stops a microphone stream that arrives after the component unmounts", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn<() => Promise<MediaStream>>(() => new Promise(resolve => {
      resolveStream = resolve;
    }));
    const stopTrack = vi.fn<() => void>();
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const settings: WorkersAiSpeechSettings = {
      modelId: "@cf/openai/whisper-large-v3-turbo",
      language: null,
      shareWithUsers: false,
      models: [{
        id: "@cf/openai/whisper-large-v3-turbo",
        name: "Whisper Large V3 Turbo",
        access: "private",
        shareable: true,
        poolSize: 0,
        availableCredentials: 0,
      }],
      sharedSecondsUsed: 0,
      sharedSecondsLimit: 1_800,
      sharedRequestsUsed: 0,
      sharedRequestsLimit: 120,
      quotaResetAt: "2026-08-31T00:00:00.000Z",
    };
    const api = {
      getWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["getWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      updateWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["updateWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      transcribeSpeech: vi.fn<AuthenticatedApi["transcribeSpeech"]>(async () => ({
        text: "unused",
        modelId: settings.modelId!,
        access: "private" as const,
      })),
    } satisfies Pick<
      AuthenticatedApi,
      "getWorkersAiSpeechSettings" | "updateWorkersAiSpeechSettings" | "transcribeSpeech"
    >;

    function Probe() {
      const speech = useSpeechInput({
        authenticatedApi: api,
        onTranscript: vi.fn<(text: string) => void>(),
        onError: vi.fn<(error: SpeechInputError) => void>(),
      });
      return <button data-status={speech.status} onClick={() => void speech.toggleRecording()}>toggle</button>;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => root.unmount());
    await act(async () => resolveStream({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream));
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("cancels recording when a desktop or mobile WebView is backgrounded", async () => {
    const stopTrack = vi.fn<() => void>();
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream) },
    });
    const settings: WorkersAiSpeechSettings = {
      modelId: "@cf/openai/whisper-large-v3-turbo",
      language: null,
      shareWithUsers: false,
      models: [{
        id: "@cf/openai/whisper-large-v3-turbo",
        name: "Whisper Large V3 Turbo",
        access: "private",
        shareable: true,
        poolSize: 0,
        availableCredentials: 0,
      }],
      sharedSecondsUsed: 0,
      sharedSecondsLimit: 1_800,
      sharedRequestsUsed: 0,
      sharedRequestsLimit: 120,
      quotaResetAt: "2026-08-31T00:00:00.000Z",
    };
    const transcribeSpeech = vi.fn<AuthenticatedApi["transcribeSpeech"]>();
    const api = {
      getWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["getWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      updateWorkersAiSpeechSettings: vi.fn<AuthenticatedApi["updateWorkersAiSpeechSettings"]>(
        async () => settings,
      ),
      transcribeSpeech,
    } satisfies Pick<
      AuthenticatedApi,
      "getWorkersAiSpeechSettings" | "updateWorkersAiSpeechSettings" | "transcribeSpeech"
    >;

    function Probe() {
      const speech = useSpeechInput({
        authenticatedApi: api,
        onTranscript: vi.fn<(text: string) => void>(),
        onError: vi.fn<(error: SpeechInputError) => void>(),
      });
      return <button data-status={speech.status} onClick={() => void speech.toggleRecording()}>toggle</button>;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")!.dataset.status).toBe("recording");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(container.querySelector("button")!.dataset.status).toBe("idle");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(transcribeSpeech).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
