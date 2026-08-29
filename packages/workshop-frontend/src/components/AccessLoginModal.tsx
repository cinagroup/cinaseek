import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldCheck } from '@phosphor-icons/react'
import {
  ACCESS_LOGIN_COMPLETE_MESSAGE,
  ACCESS_LOGIN_COMPLETE_PATH,
  ACCESS_LOGIN_REQUEST_EVENT,
  accessLoginUrl,
  type AccessSessionStatus,
} from '../accessSession'
import { useTranslation } from '../i18n'
import { isCinaSeekMobileShell } from '../nativeShell'

type LoginRequestDetail = { returnTo?: unknown }

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

function createLoginRequestId(): string {
  return crypto.randomUUID()
}

function navigateToAuthentication(returnTo: string): void {
  window.location.assign(accessLoginUrl(returnTo))
}

/** Opens Access directly from a guest action and coordinates the popup completion handshake. */
export default function AccessLoginController({
  onAuthenticated = navigateAfterAuthentication,
  openWindow = openAuthenticationWindow,
  createRequestId = createLoginRequestId,
  onFullPageAuthentication = navigateToAuthentication,
  preferFullPageAuthentication = isCinaSeekMobileShell(),
}: {
  onAuthenticated?: (returnTo: string) => void
  openWindow?: (url: string, target: string, features: string) => Window | null
  createRequestId?: () => string
  onFullPageAuthentication?: (returnTo: string) => void
  preferFullPageAuthentication?: boolean
}) {
  const popupRef = useRef<Window | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const returnToRef = useRef('/')

  const clearAttempt = useCallback((closePopup: boolean) => {
    const popup = popupRef.current
    const requestId = requestIdRef.current
    popupRef.current = null
    requestIdRef.current = null
    if (closePopup) popup?.close()
    if (requestId) {
      try { localStorage.removeItem(completionStorageKey(requestId)) } catch {}
    }
  }, [])

  const completeAuthentication = useCallback(() => {
    const returnTo = returnToRef.current
    clearAttempt(true)
    onAuthenticated(returnTo)
  }, [clearAttempt, onAuthenticated])

  const startSignIn = useCallback((requestedReturnTo: unknown) => {
    const returnTo = safeReturnTo(requestedReturnTo)
    returnToRef.current = returnTo

    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus()
      return
    }

    clearAttempt(false)
    if (preferFullPageAuthentication) {
      onFullPageAuthentication(returnTo)
      return
    }
    const requestId = createRequestId()
    requestIdRef.current = requestId
    const popup = openWindow(
      accessLoginUrl(`${ACCESS_LOGIN_COMPLETE_PATH}?request=${encodeURIComponent(requestId)}`),
      'cinaseek-access-sign-in',
      popupFeatures(),
    )
    if (!popup) {
      requestIdRef.current = null
      onFullPageAuthentication(returnTo)
      return
    }
    popupRef.current = popup
    popup.focus()
  }, [clearAttempt, createRequestId, onFullPageAuthentication, openWindow, preferFullPageAuthentication])

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<LoginRequestDetail>).detail
      startSignIn(detail?.returnTo)
    }
    window.addEventListener(ACCESS_LOGIN_REQUEST_EVENT, handleRequest)
    return () => window.removeEventListener(ACCESS_LOGIN_REQUEST_EVENT, handleRequest)
  }, [startSignIn])

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
    const timer = window.setInterval(() => {
      if (popupRef.current?.closed) clearAttempt(false)
    }, 500)
    return () => window.clearInterval(timer)
  }, [clearAttempt])

  useEffect(() => () => clearAttempt(true), [clearAttempt])

  return null
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
