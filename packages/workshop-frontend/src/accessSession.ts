/** Browser-visible Cloudflare Access session state for the public application shell. */
export type AccessSessionStatus =
  | 'not-applicable'
  | 'checking'
  | 'guest'
  | 'authenticated'
  | 'error'

const HOME_DRAFT_KEY = 'cinaseek:home-draft:v1'
const HOME_DRAFT_MAX_AGE_MS = 60 * 60 * 1000
const HOME_DRAFT_MAX_LENGTH = 32_000

type StoredHomeDraft = {
  prompt: string
  savedAt: number
}

/** Probe the Access-protected session endpoint without following an interactive login redirect. */
export async function probeAccessSession(
  fetchImpl: typeof fetch = fetch,
): Promise<Extract<AccessSessionStatus, 'guest' | 'authenticated' | 'error'>> {
  try {
    const response = await fetchImpl('/api/session', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
    })

    if (response.status === 204) return 'authenticated'
    if (response.type === 'opaqueredirect' || response.status === 0 ||
        response.status === 401 || response.status === 403 ||
        (response.status >= 300 && response.status < 400)) {
      return 'guest'
    }
    return 'error'
  } catch {
    return 'error'
  }
}

/** Return the current same-origin route so login can resume exactly where the user left off. */
export function currentReturnTo(location: Location = window.location): string {
  return `${location.pathname}${location.search}${location.hash}` || '/'
}

/** Build the same-origin Access login trigger URL. The backend validates returnTo again. */
export function accessLoginUrl(returnTo = currentReturnTo()): string {
  const search = new URLSearchParams({ returnTo })
  return `/auth/login?${search.toString()}`
}

/** Start CinaAuth sign-in/registration through the Access-protected same-origin login route. */
export function beginAccessLogin(returnTo?: string): void {
  window.location.assign(accessLoginUrl(returnTo))
}

/** Save a guest's home prompt in tab-scoped storage so it survives the login round trip. */
export function savePendingHomePrompt(prompt: string): void {
  try {
    if (!prompt) {
      sessionStorage.removeItem(HOME_DRAFT_KEY)
      return
    }
    const value: StoredHomeDraft = {
      prompt: prompt.slice(0, HOME_DRAFT_MAX_LENGTH),
      savedAt: Date.now(),
    }
    sessionStorage.setItem(HOME_DRAFT_KEY, JSON.stringify(value))
  } catch {
    // Storage can be unavailable in hardened/private browsing modes. Login still works.
  }
}

function readPendingHomePrompt(remove: boolean): string | null {
  try {
    const raw = sessionStorage.getItem(HOME_DRAFT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredHomeDraft>
    const valid = typeof value.prompt === 'string' &&
      typeof value.savedAt === 'number' &&
      Number.isFinite(value.savedAt) &&
      value.savedAt <= Date.now() &&
      Date.now() - value.savedAt <= HOME_DRAFT_MAX_AGE_MS
    if (!valid) {
      sessionStorage.removeItem(HOME_DRAFT_KEY)
      return null
    }
    if (remove) sessionStorage.removeItem(HOME_DRAFT_KEY)
    return value.prompt!.slice(0, HOME_DRAFT_MAX_LENGTH)
  } catch {
    try { sessionStorage.removeItem(HOME_DRAFT_KEY) } catch {}
    return null
  }
}

/** Read a pending guest prompt without consuming it. */
export function peekPendingHomePrompt(): string | null {
  return readPendingHomePrompt(false)
}

/** Consume a pending guest prompt after Access authentication succeeds. */
export function consumePendingHomePrompt(): string | null {
  return readPendingHomePrompt(true)
}
