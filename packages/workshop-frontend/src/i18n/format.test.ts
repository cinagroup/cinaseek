import { describe, expect, it } from 'vitest'
import { formatDate, formatList, formatNumber } from './format'

describe('locale formatting', () => {
  it('formats dates and numbers with an explicit supported locale', () => {
    const date = new Date('2026-08-28T00:00:00.000Z')
    expect(formatDate(date, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }, 'en'))
      .toBe('08/28/2026')
    expect(formatDate(date, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }, 'zh-CN'))
      .toBe('2026/08/28')
    expect(formatNumber(1234567, {}, 'en')).toBe('1,234,567')
  })

  it('formats localized lists', () => {
    expect(formatList(['A', 'B', 'C'], {}, 'en')).toBe('A, B, and C')
    expect(formatList(['甲', '乙', '丙'], {}, 'zh-CN')).toBe('甲、乙和丙')
  })
})
