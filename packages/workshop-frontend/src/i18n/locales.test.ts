import { describe, expect, it } from 'vitest'
import { normalizeLocale, resolveLocale } from './locales'

describe('normalizeLocale', () => {
  it.each([
    ['en-US', 'en'],
    ['zh_Hans_SG', 'zh-CN'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
    ['ja-JP', null],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected)
  })
})

describe('resolveLocale', () => {
  it('uses the documented precedence order', () => {
    expect(resolveLocale({
      query: 'zh-TW',
      stored: 'zh-CN',
      cookie: 'en',
      browserLanguages: ['en-US'],
    })).toBe('zh-TW')
    expect(resolveLocale({ stored: 'zh-CN', cookie: 'en', browserLanguages: ['en-US'] })).toBe('zh-CN')
    expect(resolveLocale({ cookie: 'zh-TW', browserLanguages: ['en-US'] })).toBe('zh-TW')
    expect(resolveLocale({ browserLanguages: ['ja-JP', 'zh-SG'] })).toBe('zh-CN')
  })

  it('falls back to English when no supported locale is present', () => {
    expect(resolveLocale({ browserLanguages: ['ja-JP', 'ko-KR'] })).toBe('en')
  })
})
