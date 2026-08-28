import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ShieldCheck, X } from '@phosphor-icons/react'
import {
  ACCESS_LOGIN_COMPLETE_MESSAGE,
  ACCESS_LOGIN_COMPLETE_PATH,
  ACCESS_LOGIN_REQUEST_EVENT,
  accessLoginUrl,
  type AccessSessionStatus,
} from '../accessSession'
import SiteLogo from './SiteLogo'
import { useSiteName } from '../ServerConfigContext'
import { useTranslation } from '../i18n'

type LoginRequestDetail = { returnTo?: unknown }
type LoginPhase = 'ready' | 'authenticating' | 'error'
type LoginError = 'popupClosed' | 'popupBlocked'

const POPUP_WIDTH = 520
const POPUP_HEIGHT = 760
const COMPLETION_STORAGE_PREFIX = 'cinaseek:access-login-complete:'
const COMPLETION_STORAGE_VALUE = 'complete'
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function completionStorageKey(requestId: string): string {
  return `${COMPLETION_STORAGE_PREFIX}${requestId}`
}

function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin ||
        url.pathname === ACCESS_LOGIN_COMPLETE_PATH ||
        url.pathname === '/auth/login') return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

function popupFeatures(): string {
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2))
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2))
  return [
    'popup=yes',
    `width=${POPUP_WIDTH}`,
    `height=${POPUP_HEIGHT}`,
    `left=${left}`,
    `top=${top}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',')
}

function navigateAfterAuthentication(returnTo: string): void {
  window.location.assign(returnTo)
}

function openAuthenticationWindow(url: string, target: string, features: string): Window | null {
  return window.open(url, target, features)
}

/** Branded guest sign-in shell that keeps the home page visible while Access runs in a popup. */
export default function AccessLoginModal({
  onAuthenticated = navigateAfterAuthentication,
  openWindow = openAuthenticationWindow,
  createRequestId = () => crypto.randomUUID(),
}: {
  onAuthenticated?: (returnTo: string) => void
  openWindow?: (url: string, target: string, features: string) => Window | null
  createRequestId?: () => string
}) {
  const { t } = useTranslation('auth')
  const siteName = useSiteName()
  const [returnTo, setReturnTo] = useState('/')
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<LoginPhase>('ready')
  const [error, setError] = useState<LoginError | null>(null)
  const popupRef = useRef<Window | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback(() => {
    popupRef.current?.close()
    popupRef.current = null
    if (requestIdRef.current) {
      try { localStorage.removeItem(completionStorageKey(requestIdRef.current)) } catch {}
      requestIdRef.current = null
    }
    setOpen(false)
    setPhase('ready')
    setError(null)
  }, [])

  const completeAuthentication = useCallback(() => {
    const popup = popupRef.current
    const requestId = requestIdRef.current
    popupRef.current = null
    requestIdRef.current = null
    popup?.close()
    if (requestId) {
      try { localStorage.removeItem(completionStorageKey(requestId)) } catch {}
    }
    setOpen(false)
    onAuthenticated(returnTo)
  }, [onAuthenticated, returnTo])

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<LoginRequestDetail>).detail
      setReturnTo(safeReturnTo(detail?.returnTo))
      setPhase('ready')
      setError(null)
      setOpen(true)
    }
    window.addEventListener(ACCESS_LOGIN_REQUEST_EVENT, handleRequest)
    return () => window.removeEventListener(ACCESS_LOGIN_REQUEST_EVENT, handleRequest)
  }, [])

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [close, open])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin ||
          event.source !== popupRef.current ||
          event.data?.type !== ACCESS_LOGIN_COMPLETE_MESSAGE ||
          event.data?.requestId !== requestIdRef.current) return
      completeAuthentication()
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [completeAuthentication])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      const requestId = requestIdRef.current
      if (!requestId || event.key !== completionStorageKey(requestId) ||
          event.newValue !== COMPLETION_STORAGE_VALUE) return
      completeAuthentication()
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [completeAuthentication])

  useEffect(() => {
    if (phase !== 'authenticating') return
    const timer = window.setInterval(() => {
      if (!popupRef.current?.closed) return
      popupRef.current = null
      requestIdRef.current = null
      window.clearInterval(timer)
      setPhase('error')
      setError('popupClosed')
    }, 500)
    return () => window.clearInterval(timer)
  }, [phase])

  const startSignIn = useCallback(() => {
    setError(null)
    const requestId = createRequestId()
    requestIdRef.current = requestId
    const popup = openWindow(
      accessLoginUrl(`${ACCESS_LOGIN_COMPLETE_PATH}?request=${encodeURIComponent(requestId)}`),
      'cinaseek-access-sign-in',
      popupFeatures(),
    )
    if (!popup) {
      requestIdRef.current = null
      setPhase('error')
      setError('popupBlocked')
      return
    }
    popupRef.current = popup
    setPhase('authenticating')
    popup.focus()
  }, [createRequestId, openWindow])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label={t('modal.close')}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[3px]"
        onClick={close}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-login-title"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-kumo-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-kumo-tint">
              <SiteLogo size={30}><ShieldCheck size={22} /></SiteLogo>
            </div>
            <span className="text-sm font-semibold text-kumo-strong">{siteName}</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            aria-label={t('modal.close')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
          >
            <X size={17} />
          </button>
        </div>

        <div className="px-6 py-7 sm:px-8 sm:py-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-kumo-brand/10 text-kumo-brand">
            <ShieldCheck size={27} weight="duotone" />
          </div>
          <h2 id="access-login-title" className="mt-5 text-center text-xl font-semibold text-kumo-strong">
            {t('modal.title')}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-5 text-kumo-subtle">
            {t('modal.description')}
          </p>

          {error ? (
            <div role="alert" className="mt-5 rounded-xl border border-kumo-danger/25 bg-kumo-danger-tint px-3.5 py-3 text-sm leading-5 text-kumo-danger">
              {t(`errors.${error}`)}
            </div>
          ) : null}

          <button
            type="button"
            onClick={startSignIn}
            disabled={phase === 'authenticating'}
            className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-kumo-brand px-4 text-sm font-semibold text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-wait disabled:opacity-70"
          >
            {phase === 'authenticating' ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" />
                {t('modal.waiting')}
              </>
            ) : (
              <>
                {t('modal.continue')}
                <ArrowSquareOut size={17} />
              </>
            )}
          </button>

          <a
            href={accessLoginUrl(returnTo)}
            className="mt-3 block text-center text-xs text-kumo-inactive underline-offset-4 hover:text-kumo-subtle hover:underline"
          >
            {t('modal.fullPage')}
          </a>
          <p className="mt-5 text-center text-[11px] leading-4 text-kumo-inactive">
            {t('modal.privacy')}
          </p>
        </div>
      </section>
    </div>
  )
}

/** Minimal status surface shown only inside the same-origin Access completion popup. */
export function AccessLoginComplete({ status }: { status: AccessSessionStatus }) {
  const { t } = useTranslation('auth')
  const [notified, setNotified] = useState(false)

  useEffect(() => {
    if (status !== 'authenticated') return
    const requestId = new URLSearchParams(window.location.search).get('request')
    if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) return
    let sent = false
    try {
      localStorage.setItem(completionStorageKey(requestId), COMPLETION_STORAGE_VALUE)
      sent = true
    } catch {}
    if (window.opener) {
      window.opener.postMessage(
        { type: ACCESS_LOGIN_COMPLETE_MESSAGE, requestId },
        window.location.origin,
      )
      sent = true
    }
    setNotified(sent)
    if (!sent) return
    const timer = window.setTimeout(() => window.close(), 250)
    return () => window.clearTimeout(timer)
  }, [status])

  const failed = status === 'guest' || status === 'error'
  return (
    <main className="flex min-h-screen items-center justify-center bg-kumo-base p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-kumo-brand/10 text-kumo-brand">
          <ShieldCheck size={27} weight="duotone" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-kumo-strong">
          {failed ? t('complete.failedTitle') : notified ? t('complete.successTitle') : t('complete.finishingTitle')}
        </h1>
        <p className="mt-2 text-sm text-kumo-subtle">
          {failed
            ? t('complete.failedDescription')
            : notified
              ? t('complete.successDescription')
              : t('complete.verifyingDescription')}
        </p>
        {failed || !notified ? (
          <a href="/" className="mt-5 inline-flex h-10 items-center rounded-xl bg-kumo-brand px-4 text-sm font-semibold text-white">
            {t('complete.return')}
          </a>
        ) : null}
      </div>
    </main>
  )
}
