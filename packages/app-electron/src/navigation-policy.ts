export const CINASEEK_APP_ORIGIN = 'https://cinaseek.ai'

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Returns whether a URL belongs to the production CinaSeek web application. */
export function isCinaSeekAppUrl(value: string): boolean {
  return parseUrl(value)?.origin === CINASEEK_APP_ORIGIN
}

/** Returns whether a URL is safe to navigate inside a sandboxed authentication window. */
export function isSecureWebUrl(value: string): boolean {
  const url = parseUrl(value)
  return url?.protocol === 'https:' && !url.username && !url.password && value.length <= 8192
}

/** Returns whether a user-initiated URL may be delegated to the operating-system browser. */
export function isSafeExternalUrl(value: string): boolean {
  return isSecureWebUrl(value) && !isCinaSeekAppUrl(value)
}
