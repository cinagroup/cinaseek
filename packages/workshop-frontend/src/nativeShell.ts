const MOBILE_APP_USER_AGENT = /(?:^|\s)CinaSeekMobile\/\d+(?:\.\d+)*(?:\s|$)/
const DESKTOP_APP_USER_AGENT = /(?:^|\s)CinaSeekDesktop\/\d+(?:\.\d+)*(?:\s|$)/

/** Returns whether the page is running inside the restricted CinaSeek mobile shell. */
export function isCinaSeekMobileShell(userAgent = window.navigator.userAgent): boolean {
  return MOBILE_APP_USER_AGENT.test(userAgent)
}

/** Returns whether the page is running inside the restricted CinaSeek desktop shell. */
export function isCinaSeekDesktopShell(userAgent = window.navigator.userAgent): boolean {
  return DESKTOP_APP_USER_AGENT.test(userAgent)
}
