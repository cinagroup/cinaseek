import { describe, expect, it } from 'vitest'
import { isCinaSeekMobileShell } from './nativeShell'

describe('isCinaSeekMobileShell', () => {
  it('recognizes the versioned mobile shell user-agent marker', () => {
    expect(isCinaSeekMobileShell('Mozilla/5.0 CinaSeekMobile/1.0')).toBe(true)
    expect(isCinaSeekMobileShell('CinaSeekMobile/2')).toBe(true)
  })

  it('does not classify ordinary browsers or lookalike markers as the mobile shell', () => {
    expect(isCinaSeekMobileShell('Mozilla/5.0 Chrome/140.0')).toBe(false)
    expect(isCinaSeekMobileShell('FakeCinaSeekMobile/1.0')).toBe(false)
  })
})
