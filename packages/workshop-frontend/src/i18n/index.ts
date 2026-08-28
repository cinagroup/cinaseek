import { createInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import en from './resources/en'
import {
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  resolveLocale,
  type SupportedLocale,
} from './locales'

const loadedLocales = new Set<SupportedLocale>(['en'])
const i18n = createInstance()

const baseInitialization = i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(en),
  resources: { en },
  interpolation: { escapeValue: false },
  initAsync: false,
  react: { useSuspense: false },
})

function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

function readLocaleCookie(): string | null {
  const prefix = `${LOCALE_COOKIE_NAME}=`
  const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null
}

function queryLocale(): string | null {
  return new URLSearchParams(window.location.search).get('lang')
}

function applyDocumentLocale(locale: SupportedLocale): void {
  document.documentElement.lang = locale
  document.documentElement.dir = 'ltr'
}

function persistLocale(locale: SupportedLocale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {}

  const attributes = ['Path=/', 'Max-Age=31536000', 'SameSite=Lax']
  if (window.location.hostname === 'cinaseek.ai' || window.location.hostname.endsWith('.cinaseek.ai')) {
    attributes.push('Domain=.cinaseek.ai')
  }
  if (window.location.protocol === 'https:') attributes.push('Secure')
  document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; ${attributes.join('; ')}`
}

function clearPreviewLocaleFromUrl(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('lang')) return
  url.searchParams.delete('lang')
  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  window.history.replaceState(window.history.state, '', nextUrl)
}

async function loadLocaleResources(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return
  const catalog = locale === 'zh-CN'
    ? (await import('./resources/zh-CN')).default
    : (await import('./resources/zh-TW')).default
  for (const [namespace, resources] of Object.entries(catalog)) {
    i18n.addResourceBundle(locale, namespace, resources, true, true)
  }
  loadedLocales.add(locale)
}

/** Changes the active interface locale and optionally persists the user's device preference. */
export async function setLocale(locale: SupportedLocale, persist = true): Promise<void> {
  await baseInitialization
  await loadLocaleResources(locale)
  await i18n.changeLanguage(locale)
  applyDocumentLocale(locale)
  if (persist) {
    persistLocale(locale)
    clearPreviewLocaleFromUrl()
  }
}

/** Loads the initial locale catalog before the first React render. */
export async function initializeI18n(): Promise<void> {
  await baseInitialization
  const locale = resolveLocale({
    query: queryLocale(),
    stored: readStoredLocale(),
    cookie: readLocaleCookie(),
    browserLanguages: navigator.languages,
  })
  await setLocale(locale, false)
}

/** Returns the active language as a locale supported by the application. */
export function getCurrentLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language) ?? 'en'
}

export { i18n, useTranslation }
