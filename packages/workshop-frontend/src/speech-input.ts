import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSpeechInputErrorCode,
  SPEECH_INPUT_ERROR_CODES,
  type AuthenticatedApi,
  type SpeechInputTranscription,
  type WorkersAiSpeechSettings,
  type WorkersAiSpeechSettingsUpdate,
} from "@gadgets/workshop-shared/api";

export const MAX_SPEECH_RECORDING_MS = 60_000;
export const MAX_SPEECH_AUDIO_BYTES = 5 * 1024 * 1024;
export const SPEECH_RETRY_RETENTION_MS = 5 * 60_000;

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

/** Voice-input lifecycle shown by the chat composer. */
export type SpeechInputStatus =
  | "checking"
  | "unavailable"
  | "unsupported"
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing";

/** Expected failures that the composer maps to localized, user-facing messages. */
export type SpeechInputError =
  | "permission-denied"
  | "recording-failed"
  | "audio-too-large"
  | "no-speech"
  | "model-unavailable"
  | "rate-limited"
  | "quota-exceeded"
  | "settings-failed"
  | "transcription-failed";

/** Returns the first compressed audio format the current browser can record. */
export function preferredSpeechRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string {
  return RECORDING_MIME_TYPES.find(mimeType => {
    try {
      return isTypeSupported(mimeType);
    } catch {
      return false;
    }
  }) ?? "";
}

/** Inserts a transcript at one caret position without adding spaces around CJK text. */
export function insertSpeechTranscript(
  value: string,
  transcript: string,
  position: number,
): { value: string; caret: number } {
  const normalized = transcript.trim();
  const caret = Math.max(0, Math.min(position, value.length));
  if (!normalized) return { value, caret };

  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const leadingSpace = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(normalized)
    ? " "
    : "";
  const trailingSpace = /[A-Za-z0-9]$/.test(normalized) && /^[A-Za-z0-9]/.test(after)
    ? " "
    : "";
  const inserted = leadingSpace + normalized + trailingSpace;
  return {
    value: before + inserted + after,
    caret: caret + inserted.length,
  };
}

/** Maps a server-side speech error to a stable composer failure. */
export function speechInputError(error: unknown): SpeechInputError {
  switch (getSpeechInputErrorCode(error)) {
    case SPEECH_INPUT_ERROR_CODES.notConfigured:
    case SPEECH_INPUT_ERROR_CODES.modelUnavailable:
      return "model-unavailable";
    case SPEECH_INPUT_ERROR_CODES.rateLimited:
      return "rate-limited";
    case SPEECH_INPUT_ERROR_CODES.dailyQuotaExceeded:
      return "quota-exceeded";
    default:
      return "transcription-failed";
  }
}

type SpeechApi = Pick<
  AuthenticatedApi,
  "getWorkersAiSpeechSettings" | "updateWorkersAiSpeechSettings" | "transcribeSpeech"
>;

type UseSpeechInputOptions = {
  authenticatedApi: SpeechApi;
  onTranscript: (text: string) => void;
  onError: (error: SpeechInputError) => void;
};

type RetainedRecording = {
  audio: Blob;
  durationSeconds: number;
};

/** Captures one short microphone clip and sends it to the authenticated speech RPC. */
export function useSpeechInput({
  authenticatedApi,
  onTranscript,
  onError,
}: UseSpeechInputOptions): {
  status: SpeechInputStatus;
  settings: WorkersAiSpeechSettings | null;
  settingsBusy: boolean;
  recordingSeconds: number;
  lastTranscription: SpeechInputTranscription | null;
  canRetry: boolean;
  toggleRecording: () => Promise<void>;
  cancelRecording: () => void;
  retryTranscription: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  updateSettings: (update: WorkersAiSpeechSettingsUpdate) => Promise<void>;
} {
  const [availability, setAvailability] = useState<
    "checking" | "available" | "unavailable" | "unsupported"
  >("checking");
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [settings, setSettings] = useState<WorkersAiSpeechSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [lastTranscription, setLastTranscription] = useState<SpeechInputTranscription | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const shouldTranscribeRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const retainedRecordingRef = useRef<RetainedRecording | null>(null);
  const requestGenerationRef = useRef(0);
  const durationTimerRef = useRef<number | null>(null);
  const recordingLimitTimerRef = useRef<number | null>(null);
  const retryRetentionTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  const clearRecordingTimers = useCallback(() => {
    if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
    if (recordingLimitTimerRef.current !== null) window.clearTimeout(recordingLimitTimerRef.current);
    durationTimerRef.current = null;
    recordingLimitTimerRef.current = null;
  }, []);

  const clearRetainedRecording = useCallback(() => {
    if (retryRetentionTimerRef.current !== null) {
      window.clearTimeout(retryRetentionTimerRef.current);
      retryRetentionTimerRef.current = null;
    }
    retainedRecordingRef.current = null;
    if (mountedRef.current) setCanRetry(false);
  }, []);

  const retainRecording = useCallback((recording: RetainedRecording) => {
    clearRetainedRecording();
    retainedRecordingRef.current = recording;
    if (mountedRef.current) setCanRetry(true);
    retryRetentionTimerRef.current = window.setTimeout(
      clearRetainedRecording,
      SPEECH_RETRY_RETENTION_MS,
    );
  }, [clearRetainedRecording]);

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const refreshSettings = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      if (mountedRef.current) setAvailability("unsupported");
      return;
    }
    if (mountedRef.current) {
      setAvailability("checking");
      setSettingsBusy(true);
    }
    try {
      const next = await authenticatedApi.getWorkersAiSpeechSettings();
      if (!mountedRef.current) return;
      setSettings(next);
      const selected = next.models.find(model => model.id === next.modelId);
      setAvailability(selected && (
        selected.access !== "shared-pool" || selected.availableCredentials > 0
      ) ? "available" : "unavailable");
    } catch {
      if (mountedRef.current) setAvailability("unavailable");
    } finally {
      if (mountedRef.current) setSettingsBusy(false);
    }
  }, [authenticatedApi]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshSettings();
    const handleFocus = () => {
      if (recorderRef.current === null) void refreshSettings();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current++;
      window.removeEventListener("focus", handleFocus);
      shouldTranscribeRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder?.state !== "inactive") recorder?.stop();
      clearRecordingTimers();
      stopStream();
      chunksRef.current = [];
      clearRetainedRecording();
    };
  }, [clearRecordingTimers, clearRetainedRecording, refreshSettings, stopStream]);

  const transcribeRecording = useCallback(async (recording: RetainedRecording) => {
    if (mountedRef.current) setPhase("transcribing");
    try {
      const transcript = await authenticatedApi.transcribeSpeech(recording.audio, {
        durationSeconds: recording.durationSeconds,
        wordTimestamps: true,
      });
      if (!mountedRef.current) return;
      setLastTranscription(transcript);
      if (!transcript.text.trim()) onErrorRef.current("no-speech");
      else onTranscriptRef.current(transcript.text);
      void refreshSettings();
    } catch (error) {
      if (mountedRef.current) onErrorRef.current(speechInputError(error));
    } finally {
      if (mountedRef.current) setPhase("idle");
    }
  }, [authenticatedApi, refreshSettings]);

  const finishRecording = useCallback(async (recorder: MediaRecorder) => {
    recorderRef.current = null;
    clearRecordingTimers();
    stopStream();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const shouldTranscribe = shouldTranscribeRef.current;
    shouldTranscribeRef.current = false;
    if (!shouldTranscribe) {
      if (mountedRef.current) setPhase("idle");
      return;
    }

    const mimeType = recorder.mimeType || chunks.find(chunk => chunk.type)?.type || "audio/webm";
    const audio = new Blob(chunks, { type: mimeType });
    if (audio.size > MAX_SPEECH_AUDIO_BYTES) {
      if (mountedRef.current) {
        setPhase("idle");
        onErrorRef.current("audio-too-large");
      }
      return;
    }
    if (audio.size === 0) {
      if (mountedRef.current) {
        setPhase("idle");
        onErrorRef.current("no-speech");
      }
      return;
    }

    const recording = {
      audio,
      durationSeconds: Math.min(
        MAX_SPEECH_RECORDING_MS / 1_000,
        Math.max(0.1, (Date.now() - recordingStartedAtRef.current) / 1_000),
      ),
    };
    retainRecording(recording);
    await transcribeRecording(recording);
  }, [clearRecordingTimers, retainRecording, stopStream, transcribeRecording]);

  const stopRecording = useCallback((shouldTranscribe: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    shouldTranscribeRef.current = shouldTranscribe;
    if (shouldTranscribe && mountedRef.current) setPhase("transcribing");
    recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (availability !== "available" || phase !== "idle") return;
    clearRetainedRecording();
    setLastTranscription(null);
    setPhase("requesting");
    const generation = ++requestGenerationRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (error) {
      if (generation !== requestGenerationRef.current || !mountedRef.current) return;
      onErrorRef.current(
        error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "permission-denied"
          : "recording-failed",
      );
      setPhase("idle");
      return;
    }

    if (!mountedRef.current || generation !== requestGenerationRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    try {
      const mimeType = preferredSpeechRecordingMimeType(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      shouldTranscribeRef.current = false;
      recorder.addEventListener("dataavailable", event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("error", () => {
        recorderRef.current = null;
        shouldTranscribeRef.current = false;
        clearRecordingTimers();
        stopStream();
        chunksRef.current = [];
        if (mountedRef.current) {
          setPhase("idle");
          onErrorRef.current("recording-failed");
        }
      });
      recorder.addEventListener("stop", () => {
        void finishRecording(recorder);
      }, { once: true });
      recorder.start(1_000);
      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      setPhase("recording");
      durationTimerRef.current = window.setInterval(() => {
        if (mountedRef.current) {
          setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1_000));
        }
      }, 250);
      recordingLimitTimerRef.current = window.setTimeout(
        () => stopRecording(true),
        MAX_SPEECH_RECORDING_MS,
      );
    } catch {
      for (const track of stream.getTracks()) track.stop();
      recorderRef.current = null;
      streamRef.current = null;
      chunksRef.current = [];
      onErrorRef.current("recording-failed");
      if (mountedRef.current) setPhase("idle");
    }
  }, [availability, clearRecordingTimers, clearRetainedRecording, finishRecording, phase, stopRecording, stopStream]);

  const toggleRecording = useCallback(async () => {
    if (phase === "recording") stopRecording(true);
    else await startRecording();
  }, [phase, startRecording, stopRecording]);

  const cancelRecording = useCallback(() => {
    if (phase === "requesting") {
      requestGenerationRef.current++;
      if (mountedRef.current) setPhase("idle");
      return;
    }
    if (phase !== "recording") return;
    stopRecording(false);
    if (mountedRef.current) setPhase("idle");
  }, [phase, stopRecording]);

  useEffect(() => {
    if (phase !== "recording" && phase !== "requesting") return;
    const cancelWhenHidden = () => {
      if (document.visibilityState === "hidden") cancelRecording();
    };
    const cancelOnPageHide = () => cancelRecording();
    document.addEventListener("visibilitychange", cancelWhenHidden);
    window.addEventListener("pagehide", cancelOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", cancelWhenHidden);
      window.removeEventListener("pagehide", cancelOnPageHide);
    };
  }, [cancelRecording, phase]);

  const retryTranscription = useCallback(async () => {
    const recording = retainedRecordingRef.current;
    if (!recording || phase !== "idle") return;
    await transcribeRecording(recording);
  }, [phase, transcribeRecording]);

  const updateSettings = useCallback(async (update: WorkersAiSpeechSettingsUpdate) => {
    if (mountedRef.current) setSettingsBusy(true);
    try {
      const next = await authenticatedApi.updateWorkersAiSpeechSettings(update);
      if (!mountedRef.current) return;
      setSettings(next);
      const selected = next.models.find(model => model.id === next.modelId);
      setAvailability(selected && (
        selected.access !== "shared-pool" || selected.availableCredentials > 0
      ) ? "available" : "unavailable");
    } catch {
      if (mountedRef.current) onErrorRef.current("settings-failed");
    } finally {
      if (mountedRef.current) setSettingsBusy(false);
    }
  }, [authenticatedApi]);

  const status: SpeechInputStatus = phase === "idle"
    ? availability === "available" ? "idle" : availability
    : phase;
  return {
    status,
    settings,
    settingsBusy,
    recordingSeconds,
    lastTranscription,
    canRetry,
    toggleRecording,
    cancelRecording,
    retryTranscription,
    refreshSettings,
    updateSettings,
  };
}
