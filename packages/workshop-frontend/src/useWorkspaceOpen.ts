import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
  WorkspaceReopenDataState,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'
import { linkActionLog } from './useActions'
import { useDocumentTitle } from './useDocumentTitle'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

export type WorkspaceLoadError =
  | { kind: 'open'; failure: WorkspaceOpenFailureKind }
  | { kind: 'message'; message: string }

type ObserverConfigState = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

type ReopenIntegritySnapshot = {
  draftPresent: boolean
  attachmentPresent: boolean
}

type ReopenAttempt = ReopenIntegritySnapshot & {
  workspaceId: string
  integrityKnown: boolean
  startedAt?: number
}

function reopenDataState(
  expected: boolean,
  actual: boolean,
  outcome: 'ok' | 'error',
  integrityKnown: boolean,
): WorkspaceReopenDataState {
  if (!integrityKnown) return 'unknown'
  if (!expected) return 'not_present'
  if (outcome === 'error') return 'unknown'
  return actual ? 'preserved' : 'lost'
}

type Options = {
  id: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  onMetadata: (metadata: GadgetMetadata) => void
  onShareKeyConsumed: () => void
  onInvalidShareKey: () => void
  /** Release the workspace RPC session after the page remains hidden for the grace period. */
  suspendWhenHidden?: boolean
  /** Release the workspace RPC session after a visible page remains idle for the grace period. */
  suspendWhenIdle?: boolean
  /** False while transient client state makes releasing the session unsafe. */
  canSuspend?: boolean
  /** Override the hidden-page grace period, primarily for deterministic tests. */
  hiddenSuspendDelayMs?: number
  /** Override the visible-page idle grace period, primarily for deterministic tests. */
  idleSuspendDelayMs?: number
  /** Snapshot local state immediately before suspension and after a successful reopen. */
  getReopenIntegritySnapshot?: () => ReopenIntegritySnapshot
}

export function useWorkspaceOpen({
  id,
  authenticatedApi,
  onMetadata,
  onShareKeyConsumed,
  onInvalidShareKey,
  suspendWhenHidden = false,
  suspendWhenIdle = false,
  canSuspend = true,
  hiddenSuspendDelayMs = 90_000,
  idleSuspendDelayMs = 5 * 60_000,
  getReopenIntegritySnapshot,
}: Options) {
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  const [error, setError] = useState<WorkspaceLoadError | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [observerConfig, setObserverConfig] = useState<ObserverConfigState | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [suspended, setSuspended] = useState(false)
  const openWorkspaceIdRef = useRef<string | undefined>(undefined)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  const suspendedRef = useRef(false)
  const reopenAttemptRef = useRef<ReopenAttempt | null>(null)
  const reopenReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacksRef = useRef({
    onMetadata,
    onShareKeyConsumed,
    onInvalidShareKey,
    getReopenIntegritySnapshot,
  })
  callbacksRef.current = {
    onMetadata,
    onShareKeyConsumed,
    onInvalidShareKey,
    getReopenIntegritySnapshot,
  }

  useDocumentTitle(error ? '' : metadata?.title)

  const suspendWorkspace = useCallback(() => {
    if (!id || suspendedRef.current) return
    let integrity: ReopenIntegritySnapshot = { draftPresent: false, attachmentPresent: false }
    let integrityKnown = true
    try {
      integrity = callbacksRef.current.getReopenIntegritySnapshot?.() ?? integrity
    } catch {
      // Lifecycle telemetry must never prevent suspension.
      integrityKnown = false
    }
    reopenAttemptRef.current = { workspaceId: id, integrityKnown, ...integrity }
    suspendedRef.current = true
    setSuspended(true)
  }, [id])

  const resumeWorkspace = useCallback(() => {
    if (!id || !suspendedRef.current) return
    suspendedRef.current = false
    const attempt = reopenAttemptRef.current
    if (attempt?.workspaceId === id) attempt.startedAt = Date.now()
    setSuspended(false)
  }, [id])

  useEffect(() => () => {
    if (reopenReportTimerRef.current !== null) clearTimeout(reopenReportTimerRef.current)
  }, [])

  useEffect(() => {
    if (!suspendWhenHidden) {
      suspendedRef.current = false
      reopenAttemptRef.current = null
      setSuspended(false)
      return
    }

    let suspendTimer: ReturnType<typeof setTimeout> | null = null
    const clearSuspendTimer = () => {
      if (suspendTimer !== null) clearTimeout(suspendTimer)
      suspendTimer = null
    }
    const updateVisibility = () => {
      clearSuspendTimer()
      if (document.visibilityState === 'hidden' && canSuspend) {
        suspendTimer = setTimeout(suspendWorkspace, Math.max(0, hiddenSuspendDelayMs))
      } else {
        resumeWorkspace()
      }
    }

    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      clearSuspendTimer()
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [suspendWhenHidden, canSuspend, hiddenSuspendDelayMs, id, resumeWorkspace, suspendWorkspace])

  useEffect(() => {
    if (!suspendWhenIdle) return

    let suspendTimer: ReturnType<typeof setTimeout> | null = null
    const clearSuspendTimer = () => {
      if (suspendTimer !== null) clearTimeout(suspendTimer)
      suspendTimer = null
    }
    const scheduleIdleSuspension = () => {
      clearSuspendTimer()
      if (document.visibilityState === 'visible' && canSuspend) {
        suspendTimer = setTimeout(suspendWorkspace, Math.max(0, idleSuspendDelayMs))
      }
    }
    const recordActivity = () => {
      if (document.visibilityState !== 'visible') return
      resumeWorkspace()
      scheduleIdleSuspension()
    }
    const updateVisibility = () => {
      if (document.visibilityState === 'visible') recordActivity()
      else clearSuspendTimer()
    }

    if (!canSuspend) resumeWorkspace()
    scheduleIdleSuspension()
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('pointerdown', recordActivity, { passive: true })
    window.addEventListener('keydown', recordActivity)
    window.addEventListener('touchstart', recordActivity, { passive: true })
    window.addEventListener('wheel', recordActivity, { passive: true })
    return () => {
      clearSuspendTimer()
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('pointerdown', recordActivity)
      window.removeEventListener('keydown', recordActivity)
      window.removeEventListener('touchstart', recordActivity)
      window.removeEventListener('wheel', recordActivity)
    }
  }, [suspendWhenIdle, canSuspend, idleSuspendDelayMs, id, resumeWorkspace, suspendWorkspace])

  useEffect(() => {
    if (suspended && id) {
      setOverseer(null)
      setConnectionLost(false)
      return
    }

    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let cancelled = false
    const hadOpenWorkspace = id !== undefined && openWorkspaceIdRef.current === id
    const reopenAttempt = id !== undefined && reopenAttemptRef.current?.workspaceId === id &&
        reopenAttemptRef.current.startedAt !== undefined
      ? { ...reopenAttemptRef.current, startedAt: reopenAttemptRef.current.startedAt }
      : null

    const reportReopen = (
      attempt: ReopenAttempt & { startedAt: number },
      outcome: 'ok' | 'error',
      after: ReopenIntegritySnapshot,
      durationMs: number,
      afterKnown = true,
    ) => {
      try {
        void Promise.resolve(authenticatedApi.recordWorkspaceReopen({
          workspaceId: attempt.workspaceId,
          durationMs,
          outcome,
          draftState: reopenDataState(
            attempt.draftPresent,
            after.draftPresent,
            outcome,
            attempt.integrityKnown && afterKnown,
          ),
          attachmentState: reopenDataState(
            attempt.attachmentPresent,
            after.attachmentPresent,
            outcome,
            attempt.integrityKnown && afterKnown,
          ),
        })).catch(() => {})
      } catch {
        // Lifecycle telemetry must never change workspace behavior.
      }
    }

    const finishReopen = (outcome: 'ok' | 'error') => {
      if (!reopenAttempt) return
      reopenAttemptRef.current = null
      const durationMs = Math.max(0, Date.now() - reopenAttempt.startedAt)
      if (outcome === 'error') {
        reportReopen(reopenAttempt, outcome, reopenAttempt, durationMs)
        return
      }
      if (reopenReportTimerRef.current !== null) clearTimeout(reopenReportTimerRef.current)
      reopenReportTimerRef.current = setTimeout(() => {
        reopenReportTimerRef.current = null
        let after: ReopenIntegritySnapshot = { draftPresent: false, attachmentPresent: false }
        let afterKnown = true
        try {
          after = callbacksRef.current.getReopenIntegritySnapshot?.() ?? after
        } catch {
          afterKnown = false
        }
        reportReopen(reopenAttempt, outcome, after, durationMs, afterKnown)
      }, 0)
    }

    const disposeAttempt = () => {
      metadataSubscription?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
      configureObservers?.[Symbol.dispose]()
      metadataSubscription = null
      overseerStub = null
      configureObservers = null
    }

    const showTerminalError = (nextError: WorkspaceLoadError) => {
      disposeAttempt()
      openWorkspaceIdRef.current = undefined
      setOverseer(null)
      setMetadata(null)
      setConnectionLost(false)
      setError(nextError)
    }

    const load = async () => {
      if (!id) {
        showTerminalError({ kind: 'open', failure: 'not-found' })
        return
      }
      if (!hadOpenWorkspace) setError(null)

      try {
        const hash = window.location.hash
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) callbacksRef.current.onShareKeyConsumed()

        const configureObserversTarget = new (class extends RpcTarget implements ObserverConfigCallback {
          configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
            if (cancelled) return Promise.reject(new Error('Cancelled'))
            return new Promise<ObserverAccountChoice[]>((resolve, reject) => {
              pendingObserverRejectRef.current = reject
              setObserverConfig({
                needs,
                resolve: choices => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  resolve(choices)
                },
                reject: observerError => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  reject(observerError)
                },
              })
            })
          }
        })()
        configureObservers = new RpcStub(configureObserversTarget)

        overseerStub = authenticatedApi.openGadget(id, shareKey, configureObservers)
        linkActionLog(overseerStub, id)
        setOverseer({ stub: overseerStub })

        const resolvedSubscription = await overseerStub.subscribeToMetadata((nextMetadata) => {
          if (cancelled) return
          setMetadata(nextMetadata)
          callbacksRef.current.onMetadata(nextMetadata)
        })
        if (cancelled) {
          resolvedSubscription[Symbol.dispose]()
          return
        }
        metadataSubscription = resolvedSubscription

        openWorkspaceIdRef.current = id
        setError(null)
        if (connectionLost) setConnectionLost(false)
        finishReopen('ok')
      } catch (caught) {
        if (cancelled) return
        console.error('Failed to load gadget:', caught)
        finishReopen('error')

        // TODO: Give share-link and observer failures stable codes so this remaining legacy
        // message classification can be removed.
        const message = caught instanceof Error ? caught.message : ''
        if (message.includes('Invalid or expired share key')) {
          callbacksRef.current.onInvalidShareKey()
        }
        if (message.includes(OBSERVER_CANCELLED)) {
          showTerminalError({
            kind: 'message',
            message: 'To open this workspace, you must choose connected accounts for the services it uses.',
          })
        } else if (message.includes('permitted to observe') ||
                   message.includes('no longer connected') ||
                   message.includes('connect an account for every service')) {
          showTerminalError({ kind: 'message', message })
        } else {
          const failure = classifyWorkspaceOpenFailure(caught)
          if (failure !== 'unexpected') {
            showTerminalError({ kind: 'open', failure })
          } else if (!hadOpenWorkspace) {
            reportIssue('gadget.load', caught, { gadgetId: id })
            showTerminalError({ kind: 'open', failure })
          } else if (!connectionLost) {
            setConnectionLost(true)
          }
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (pendingObserverRejectRef.current) {
        pendingObserverRejectRef.current(new Error('Cancelled'))
        pendingObserverRejectRef.current = null
      }
      setObserverConfig(null)
      disposeAttempt()
    }
  }, [id, authenticatedApi, reloadNonce, suspended])

  return {
    overseer,
    metadata,
    error,
    connectionLost,
    suspended,
    observerConfig,
    retry() {
      setError(null)
      setReloadNonce(value => value + 1)
    },
    cancelObserverConfig() {
      observerConfig?.reject(new Error(OBSERVER_CANCELLED))
    },
    updateTitle(title: string) {
      setMetadata(previous => previous ? { ...previous, title } : null)
    },
  }
}
