const MOBILE_APP_USER_AGENT = /(?:^|\s)CinaSeekMobile\/\d+(?:\.\d+)*(?:\s|$)/

/** Returns whether the page is running inside the restricted CinaSeek mobile shell. */
export function isCinaSeekMobileShell(userAgent = window.navigator.userAgent): boolean {
  return MOBILE_APP_USER_AGENT.test(userAgent)
}
