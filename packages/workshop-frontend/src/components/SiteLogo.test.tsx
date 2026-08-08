// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../ServerConfigContext'
import SiteLogo, { DEFAULT_SITE_LOGO_URL } from './SiteLogo'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SiteLogo', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    act(() => root?.unmount())
    container?.remove()
  })

  function render(logoUrl?: string) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    let config = { siteLogo: logoUrl ? { url: logoUrl } : undefined } as ServerConfig
    act(() => root!.render(
      <ServerConfigContext.Provider value={config}>
        <SiteLogo size={20}><span data-fallback>fallback</span></SiteLogo>
      </ServerConfigContext.Provider>,
    ))
  }

  function rerender(logoUrl?: string) {
    let config = { siteLogo: logoUrl ? { url: logoUrl } : undefined } as ServerConfig
    act(() => root!.render(
      <ServerConfigContext.Provider value={config}>
        <SiteLogo size={20}><span data-fallback>fallback</span></SiteLogo>
      </ServerConfigContext.Provider>,
    ))
  }

  it('renders the configured logo as a decorative contained image', () => {
    render('/api/site-logo?v=revision')
    let image = container!.querySelector('img')!
    expect(image.getAttribute('src')).toBe('/api/site-logo?v=revision')
    expect(image.getAttribute('alt')).toBe('')
    expect(image.width).toBe(20)
    expect(image.height).toBe(20)
    expect(container!.querySelector('[data-fallback]')).toBeNull()
  })

  it('uses the CinaSeek logo when no custom logo is configured', () => {
    render()
    expect(container!.querySelector('img')?.getAttribute('src')).toBe(DEFAULT_SITE_LOGO_URL)
    expect(container!.querySelector('[data-fallback]')).toBeNull()
  })

  it('uses the supplied fallback when the selected logo fails to load', () => {
    render('/api/site-logo?v=revision')
    act(() => container!.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container!.querySelector('img')).toBeNull()
    expect(container!.querySelector('[data-fallback]')).not.toBeNull()

    rerender('/api/site-logo?v=revision')
    expect(container!.querySelector('img')).not.toBeNull()
  })

  it('uses an explicit null override to preview the CinaSeek default in Admin', () => {
    render('/api/site-logo?v=configured')
    const config = { siteLogo: { url: '/api/site-logo?v=configured' } } as ServerConfig
    act(() => root!.render(
      <ServerConfigContext.Provider value={config}>
        <SiteLogo size={20} srcOverride={null}>
          <span data-fallback>fallback</span>
        </SiteLogo>
      </ServerConfigContext.Provider>,
    ))

    expect(container!.querySelector('img')?.getAttribute('src')).toBe(DEFAULT_SITE_LOGO_URL)
    expect(container!.querySelector('[data-fallback]')).toBeNull()
  })

})
