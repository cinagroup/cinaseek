const DEFAULT_AGENT_MAX_TURNS = 30;
const DEFAULT_AGENT_MAX_DURATION_MS = 30 * 60 * 1000;
const MIN_AGENT_MAX_DURATION_MS = 60 * 1000;
const MAX_AGENT_MAX_DURATION_MS = 60 * 60 * 1000;

/** Resolves the bounded model/tool iteration ceiling for one agent invocation. */
export function resolveAgentMaxTurns(value: string | undefined): number {
  let configured = Number(value);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 30
    ? configured
    : DEFAULT_AGENT_MAX_TURNS;
}

/** Resolves the bounded wall-clock ceiling for one agent invocation. */
export function resolveAgentMaxDurationMs(value: string | undefined): number {
  let configured = Number(value);
  return Number.isSafeInteger(configured) && configured >= MIN_AGENT_MAX_DURATION_MS &&
      configured <= MAX_AGENT_MAX_DURATION_MS
    ? configured
    : DEFAULT_AGENT_MAX_DURATION_MS;
}

/**
 * Builds the executable snapshot identity used by the Dynamic Worker Loader cache.
 * Conversation-only sequence changes are intentionally absent from preview identities, while
 * mainline identities depend only on this gadget's immutable commit and runtime capabilities.
 */
export function dynamicWorkerExecutionVersion(
    mainlineCommitId: string | undefined,
    runtimeRevision: number,
    preview?: {chatId: number, generation: number, revision: number},
): string {
  if (preview) {
    return `preview.${preview.chatId}.${preview.generation}.${preview.revision}.r${runtimeRevision}`;
  }
  return `main.${mainlineCommitId ?? "empty"}.r${runtimeRevision}`;
}
