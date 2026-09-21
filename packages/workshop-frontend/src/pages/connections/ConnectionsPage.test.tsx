// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const state = vi.hoisted(() => ({
  vendors: [{ id: 'mcp', description: { displayName: 'MCP Server', url: 'https://modelcontextprotocol.io' }, supportedResources: [{ urlPattern: 'https://*', title: 'Any MCP server' }] }],
  connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://example.test/gatekeeper/mcp/account/nonce' })),
  toast: { add: vi.fn<() => void>() },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'CinaSeek' }))
vi.mock('../../useGatekeeperApps', () => ({ refreshGatekeeperApps: vi.fn<() => void>() }))
vi.mock('../../useConnectedAccounts', () => ({ useConnectedAccounts: () => ({ accounts: [], loaded: true, loadError: false }) }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => state.toast,
}))

const api = {
  listGatekeeperVendors: async () => state.vendors,
  listAddableGatekeepers: async () => [],
  connectAccount: state.connectAccount,
}
import { ConnectionsPage as Page } from './ConnectionsPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Connections personal search flow', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    state.connectAccount.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(window, 'open').mockReturnValue(null)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['Tavily', 'Firecrawl'])('shows %s by default, discloses credits, and connects through MCP', async name => {
    await act(async () => root.render(<Page />))
    const card = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(node => node.textContent?.includes(name))!
    expect(card).toBeDefined()
    expect(card.querySelector('img')?.src).toMatch(/^data:image\/svg\+xml,/)
    expect(state.connectAccount).not.toHaveBeenCalled()
    await act(async () => card.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('never a fallback CinaSeek key')
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes(`Continue to ${name}`))!
    expect(confirm).toBeDefined()
    await act(async () => confirm.click())
    expect(state.connectAccount).toHaveBeenCalledExactlyOnceWith('mcp', undefined)
    expect(window.open).toHaveBeenCalledWith(`https://example.test/gatekeeper/mcp/account/nonce?preset=${name.toLowerCase()}`, '_blank', 'noopener,noreferrer')
  })

  it('does not show search presets when the deployment does not offer MCP', async () => {
    const prior = state.vendors
    state.vendors = []
    try {
      await act(async () => root.render(<Page />))
      expect(container.textContent).not.toContain('Tavily')
      expect(container.textContent).not.toContain('Firecrawl')
      expect(state.connectAccount).not.toHaveBeenCalled()
    } finally { state.vendors = prior }
  })
})
