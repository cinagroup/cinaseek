/** Locales currently shipped by the CinaSeek interface. */
export const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW'] as const

/** A locale for which CinaSeek ships a complete interface catalog. */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Browser storage key for the versioned, device-local locale preference. */
export const LOCALE_STORAGE_KEY = 'cinaseek:locale:v1'

/** Non-sensitive cross-subdomain cookie used by CinaSeek and CinaAuth. */
export const LOCALE_COOKIE_NAME = 'cina_locale'

export type LocaleOption = {
  locale: SupportedLocale
  nativeName: string
}
/** Language options shown in every language picker, using self-identifying names. */
export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { locale: 'en', nativeName: 'English' },
  { locale: 'zh-CN', nativeName: '简体中文' },
  { locale: 'zh-TW', nativeName: '繁體中文' },
]

/** Maps a browser or BCP 47 language tag to a locale supported by CinaSeek. */
export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null
  const normalized = value.trim().replaceAll('_', '-').toLowerCase()
  if (!normalized) return null
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo' ||
      normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-TW'
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' ||
      normalized === 'zh-hans' || normalized.startsWith('zh-hans-') ||
      normalized.startsWith('zh-')) return 'zh-CN'
  return null
}

export type LocaleResolutionInput = {
  query?: string | null
  stored?: string | null
  cookie?: string | null
  browserLanguages?: readonly string[]
}

/** Resolves the initial locale in explicit-query, device, cookie, browser, fallback order. */
export function resolveLocale({
  query,
  stored,
  cookie,
  browserLanguages = [],
}: LocaleResolutionInput): SupportedLocale {
  const direct = normalizeLocale(query) ?? normalizeLocale(stored) ?? normalizeLocale(cookie)
  if (direct) return direct
  for (const language of browserLanguages) {
    const locale = normalizeLocale(language)
    if (locale) return locale
  }
  return 'en'
}
