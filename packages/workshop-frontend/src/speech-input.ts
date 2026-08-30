import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";

export const MAX_SPEECH_RECORDING_MS = 60_000;
export const MAX_SPEECH_AUDIO_BYTES = 5 * 1024 * 1024;

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

type UseSpeechInputOptions = {
  authenticatedApi: Pick<AuthenticatedApi, "listWorkersAiCatalog" | "transcribeSpeech">;
  onTranscript: (text: string) => void;
  onError: (error: SpeechInputError) => void;
};

/** Captures one short microphone clip and sends it to the authenticated speech RPC. */
export function useSpeechInput({
  authenticatedApi,
  onTranscript,
  onError,
}: UseSpeechInputOptions): {
  status: SpeechInputStatus;
  recordingSeconds: number;
  toggleRecording: () => Promise<void>;
  cancelRecording: () => void;
} {
  const [availability, setAvailability] = useState<
    "checking" | "available" | "unavailable" | "unsupported"
  >("checking");
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const shouldTranscribeRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const durationTimerRef = useRef<number | null>(null);
  const recordingLimitTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  const clearTimers = useCallback(() => {
    if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
    if (recordingLimitTimerRef.current !== null) window.clearTimeout(recordingLimitTimerRef.current);
    durationTimerRef.current = null;
    recordingLimitTimerRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const refreshAvailability = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      if (mountedRef.current) setAvailability("unsupported");
      return;
    }
    if (mountedRef.current) setAvailability("checking");
    try {
      const models = await authenticatedApi.listWorkersAiCatalog(
        "automatic-speech-recognition",
      );
      if (mountedRef.current) setAvailability(models.length > 0 ? "available" : "unavailable");
    } catch {
      if (mountedRef.current) setAvailability("unavailable");
    }
  }, [authenticatedApi]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshAvailability();
    const handleFocus = () => {
      if (recorderRef.current === null) void refreshAvailability();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", handleFocus);
      shouldTranscribeRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder?.state !== "inactive") recorder?.stop();
      clearTimers();
      stopStream();
      chunksRef.current = [];
    };
  }, [clearTimers, refreshAvailability, stopStream]);

  const finishRecording = useCallback(async (recorder: MediaRecorder) => {
    recorderRef.current = null;
    clearTimers();
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

    if (mountedRef.current) setPhase("transcribing");
    try {
      const transcript = await authenticatedApi.transcribeSpeech(audio);
      if (!mountedRef.current) return;
      if (!transcript.text.trim()) onErrorRef.current("no-speech");
      else onTranscriptRef.current(transcript.text);
    } catch {
      if (mountedRef.current) onErrorRef.current("transcription-failed");
    } finally {
      if (mountedRef.current) setPhase("idle");
    }
  }, [authenticatedApi, clearTimers, stopStream]);

  const stopRecording = useCallback((shouldTranscribe: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    shouldTranscribeRef.current = shouldTranscribe;
    if (shouldTranscribe && mountedRef.current) setPhase("transcribing");
    recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (availability !== "available" || phase !== "idle") return;
    setPhase("requesting");
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
      onErrorRef.current(
        error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "permission-denied"
          : "recording-failed",
      );
      if (mountedRef.current) setPhase("idle");
      return;
    }

    if (!mountedRef.current) {
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
        shouldTranscribeRef.current = false;
        clearTimers();
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
      onErrorRef.current("recording-failed");
      if (mountedRef.current) setPhase("idle");
    }
  }, [availability, clearTimers, finishRecording, phase, stopRecording, stopStream]);

  const toggleRecording = useCallback(async () => {
    if (phase === "recording") stopRecording(true);
    else await startRecording();
  }, [phase, startRecording, stopRecording]);

  const cancelRecording = useCallback(() => {
    if (phase !== "recording") return;
    stopRecording(false);
    if (mountedRef.current) setPhase("idle");
  }, [phase, stopRecording]);

  const status: SpeechInputStatus = phase === "idle"
    ? availability === "available" ? "idle" : availability
    : phase;
  return { status, recordingSeconds, toggleRecording, cancelRecording };
}
