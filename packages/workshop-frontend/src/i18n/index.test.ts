// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setLocale } from './index'
import { LOCALE_STORAGE_KEY } from './locales'

describe('setLocale', () => {
  afterEach(async () => {
    localStorage.clear()
    await setLocale('en', false)
  })

  it('lazy-loads a catalog and updates the document and device preference', async () => {
    window.history.replaceState({}, '', '/?lang=en&prompt=hello')
    await setLocale('zh-CN')

    expect(i18n.t('home:hero.title')).toBe('构建所需，始终可控。')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.documentElement.dir).toBe('ltr')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN')
    expect(document.cookie).toContain('cina_locale=zh-CN')
    expect(window.location.search).toBe('?prompt=hello')
  })
})
