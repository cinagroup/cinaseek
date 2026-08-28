import { getCurrentLocale } from './index'
import type { SupportedLocale } from './locales'

type DateValue = Date | number | string

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>()
const listFormatters = new Map<string, Intl.ListFormat>()

function cacheKey(locale: SupportedLocale, options: object): string {
  return `${locale}:${JSON.stringify(options)}`
}
function dateTimeFormatter(locale: SupportedLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = cacheKey(locale, options)
  let formatter = dateTimeFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    dateTimeFormatters.set(key, formatter)
  }
  return formatter
}

function toDate(value: DateValue): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Formats a date with the active interface locale. */
export function formatDate(
  value: DateValue,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  locale: SupportedLocale = getCurrentLocale(),
): string {
  return dateTimeFormatter(locale, options).format(toDate(value))
}

/** Formats a date and time with the active interface locale. */
export function formatDateTime(
  value: DateValue,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' },
  locale: SupportedLocale = getCurrentLocale(),
): string {
  return dateTimeFormatter(locale, options).format(toDate(value))
}

/** Formats a time with the active interface locale. */
export function formatTime(
  value: DateValue,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' },
  locale: SupportedLocale = getCurrentLocale(),
): string {
  return dateTimeFormatter(locale, options).format(toDate(value))
}

/** Formats a number with the active interface locale. */
export function formatNumber(
  value: number | bigint,
  options: Intl.NumberFormatOptions = {},
  locale: SupportedLocale = getCurrentLocale(),
): string {
  const key = cacheKey(locale, options)
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    numberFormatters.set(key, formatter)
  }
  return formatter.format(value)
}

/** Formats a relative duration such as “3 days ago” with the active interface locale. */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
  locale: SupportedLocale = getCurrentLocale(),
): string {
  const key = cacheKey(locale, options)
  let formatter = relativeTimeFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, options)
    relativeTimeFormatters.set(key, formatter)
  }
  return formatter.format(value, unit)
}

/** Formats a human-readable list with the active interface locale. */
export function formatList(
  values: readonly string[],
  options: Intl.ListFormatOptions = { style: 'long', type: 'conjunction' },
  locale: SupportedLocale = getCurrentLocale(),
): string {
  const key = cacheKey(locale, options)
  let formatter = listFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.ListFormat(locale, options)
    listFormatters.set(key, formatter)
  }
  return formatter.format(values)
}
