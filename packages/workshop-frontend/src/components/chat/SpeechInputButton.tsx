import { useEffect, useMemo, useState } from "react";
import { Popover, Tooltip } from "@cloudflare/kumo";
import {
  ArrowsClockwise,
  CaretDown,
  Microphone,
  SpinnerGap,
} from "@phosphor-icons/react";
import type { AuthenticatedApi, WorkersAiSpeechSettingsUpdate } from "@gadgets/workshop-shared/api";
import { useTranslation } from "../../i18n";
import { WorkshopIconButton } from "../WorkshopControls";
import { useSpeechInput, type SpeechInputError } from "../../speech-input";

type SpeechInputButtonProps = {
  authenticatedApi: Pick<
    AuthenticatedApi,
    "getWorkersAiSpeechSettings" | "updateWorkersAiSpeechSettings" | "transcribeSpeech"
  >;
  disabled: boolean;
  onTranscript: (text: string) => void;
  onError: (error: SpeechInputError) => void;
};

const SPEECH_LANGUAGES = [
  { value: "", labelKey: "composer.voiceLanguageAuto" },
  { value: "zh", labelKey: "composer.voiceLanguageChinese" },
  { value: "en", labelKey: "composer.voiceLanguageEnglish" },
  { value: "ja", labelKey: "composer.voiceLanguageJapanese" },
  { value: "ko", labelKey: "composer.voiceLanguageKorean" },
  { value: "es", labelKey: "composer.voiceLanguageSpanish" },
  { value: "fr", labelKey: "composer.voiceLanguageFrench" },
  { value: "de", labelKey: "composer.voiceLanguageGerman" },
] as const;

/** Chat-composer voice control with recording state and per-user Workers AI settings. */
export function SpeechInputButton({
  authenticatedApi,
  disabled,
  onTranscript,
  onError,
}: SpeechInputButtonProps) {
  const { t } = useTranslation("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
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
  } = useSpeechInput({ authenticatedApi, onTranscript, onError });

  useEffect(() => {
    if (status !== "recording" && status !== "requesting") return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      cancelRecording();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [cancelRecording, status]);

  const selectedModel = settings?.models.find(model => model.id === settings.modelId);
  const recordingTime = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
  const label = status === "recording"
    ? t("composer.voiceStopRecording", { time: recordingTime })
    : status === "transcribing"
      ? t("composer.voiceTranscribing")
      : status === "requesting"
        ? t("composer.voiceRequesting")
        : status === "checking"
          ? t("composer.voiceChecking")
          : status === "unsupported"
            ? t("composer.voiceUnsupported")
            : status === "unavailable"
              ? t("composer.voiceUnavailable")
              : t("composer.voiceStartRecording");
  const microphoneDisabled = status !== "recording" && (status !== "idle" || disabled);
  const quotaMinutes = settings
    ? `${Math.ceil(settings.sharedSecondsUsed / 60)} / ${Math.floor(settings.sharedSecondsLimit / 60)}`
    : "—";
  const timingCount = lastTranscription?.words?.length ?? 0;

  const update = (change: Partial<WorkersAiSpeechSettingsUpdate>) => {
    if (!settings?.modelId) return;
    const modelId = change.modelId ?? settings.modelId;
    const model = settings.models.find(candidate => candidate.id === modelId);
    const next: WorkersAiSpeechSettingsUpdate = {
      modelId,
      language: change.language === undefined ? settings.language : change.language,
      shareWithUsers: change.shareWithUsers ?? (
        model?.access !== "shared-pool" && model?.shareable ? settings.shareWithUsers : false
      ),
    };
    void updateSettings(next);
  };

  const modelOptions = useMemo(() => settings?.models ?? [], [settings?.models]);

  return (
    <div className="flex items-center gap-0.5">
      {status === "recording" && (
        <span
          className="min-w-9 text-center font-mono text-[11px] tabular-nums text-kumo-danger"
          aria-live="polite"
        >
          {recordingTime}
        </span>
      )}
      {status === "transcribing" && (
        <span className="hidden text-[11px] text-kumo-inactive sm:inline" aria-live="polite">
          {t("composer.voiceTranscribing")}
        </span>
      )}
      <Tooltip content={label} side="top" asChild>
        <span className="inline-flex">
          <WorkshopIconButton
            onClick={() => void toggleRecording()}
            disabled={microphoneDisabled}
            className={`!h-10 !w-10 sm:!h-8 sm:!w-8 ${
              status === "recording"
                ? "!bg-kumo-danger !text-white enabled:hover:!bg-kumo-danger enabled:hover:!text-white"
                : ""
            }`}
            aria-label={label}
            aria-pressed={status === "recording"}
          >
            {status === "transcribing" || status === "requesting" ? (
              <SpinnerGap size={17} className="animate-spin" />
            ) : (
              <Microphone size={17} weight={status === "recording" ? "fill" : "regular"} />
            )}
          </WorkshopIconButton>
        </span>
      </Tooltip>
      <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label={t("composer.voiceSettings")}
              className="inline-flex h-8 w-5 items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <CaretDown size={11} weight="bold" />
            </button>
          }
        />
        <Popover.Content
          align="end"
          side="top"
          sideOffset={8}
          positionMethod="fixed"
          className="themed-floating-shadow !z-[1100] !w-[min(360px,calc(100vw-24px))] !min-w-0 rounded-xl border border-kumo-line bg-kumo-base !p-0 [&>:first-child]:hidden"
        >
          <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
            <Popover.Title className="text-[13px] font-semibold text-kumo-default">
              {t("composer.voiceSettings")}
            </Popover.Title>
            <button
              type="button"
              disabled={settingsBusy}
              onClick={() => void refreshSettings()}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-kumo-subtle hover:bg-kumo-tint disabled:opacity-50"
            >
              <ArrowsClockwise size={13} className={settingsBusy ? "animate-spin" : ""} />
              {t("composer.voiceRefresh")}
            </button>
          </div>
          <div className="grid gap-3 px-4 py-3 text-[12px] text-kumo-subtle">
            <label className="grid gap-1">
              <span className="font-medium text-kumo-default">{t("composer.voiceModel")}</span>
              <select
                aria-label={t("composer.voiceModel")}
                disabled={settingsBusy || modelOptions.length === 0}
                value={settings?.modelId ?? ""}
                onChange={event => update({ modelId: event.currentTarget.value })}
                className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default outline-none focus:border-kumo-ring disabled:opacity-50"
              >
                {modelOptions.length === 0 && <option value="">{t("composer.voiceNoModels")}</option>}
                {modelOptions.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {t(`composer.voiceAccess.${model.access}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="font-medium text-kumo-default">{t("composer.voiceLanguage")}</span>
              <select
                aria-label={t("composer.voiceLanguage")}
                disabled={settingsBusy || !settings?.modelId}
                value={settings?.language ?? ""}
                onChange={event => update({ language: event.currentTarget.value || null })}
                className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default outline-none focus:border-kumo-ring disabled:opacity-50"
              >
                {SPEECH_LANGUAGES.map(language => (
                  <option key={language.value} value={language.value}>{t(language.labelKey)}</option>
                ))}
              </select>
            </label>
            <label className={`flex items-start gap-2 ${
              selectedModel?.access === "shared-pool" || !selectedModel?.shareable
                ? "opacity-50"
                : ""
            }`}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-current"
                checked={settings?.shareWithUsers ?? false}
                disabled={settingsBusy || selectedModel?.access === "shared-pool" || !selectedModel?.shareable}
                onChange={event => update({ shareWithUsers: event.currentTarget.checked })}
              />
              <span>
                <span className="block font-medium text-kumo-default">{t("composer.voiceShare")}</span>
                <span className="mt-0.5 block leading-4">{t("composer.voiceShareDescription")}</span>
              </span>
            </label>
            {selectedModel && (
              <div className="rounded-lg bg-kumo-tint/60 px-3 py-2 leading-4">
                <div>{t("composer.voicePoolHealth", {
                  available: selectedModel.availableCredentials,
                  total: selectedModel.poolSize,
                })}</div>
                <div>{t("composer.voiceSharedQuota", { minutes: quotaMinutes })}</div>
              </div>
            )}
            <button
              type="button"
              disabled={!canRetry || status !== "idle"}
              onClick={() => void retryTranscription()}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-kumo-line px-3 font-medium text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("composer.voiceRetry")}
            </button>
            {lastTranscription && (
              <p className="m-0 text-[11px] leading-4 text-kumo-inactive">
                {t("composer.voiceLastResult", {
                  access: t(`composer.voiceAccess.${lastTranscription.access}`),
                  count: timingCount,
                })}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover>
    </div>
  );
}
