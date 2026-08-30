import { isCinaSeekAppUrl } from './navigation-policy.js'

const ALLOWED_NON_MEDIA_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** Allows only low-risk app permissions and audio-only media capture from the CinaSeek origin. */
export function mayUseCinaSeekPermission(
  permission: string,
  requestingUrl: string,
  mediaTypes: readonly string[] = [],
): boolean {
  if (!isCinaSeekAppUrl(requestingUrl)) return false
  if (permission === 'media') {
    return mediaTypes.length === 1 && mediaTypes[0] === 'audio'
  }
  return ALLOWED_NON_MEDIA_PERMISSIONS.has(permission)
}
