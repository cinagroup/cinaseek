// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useEffect, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { AccountOption } from './gatekeeper-modal/AccountChooser'
import type ResourceConfiguratorHost from './ResourceConfiguratorHost'
import GatekeeperModal, { type GatekeeperModalProps } from './GatekeeperModal'

const state = vi.hoisted(() => ({ toast: { add: vi.fn<(toast: unknown) => void>() } }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'CinaSeek' }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => state.toast,
}))
// The iframe/RPC runtime is covered separately. Keep the real modal and account chooser here.
vi.mock('./ResourceConfiguratorHost', () => ({
  default: ({ frame, initialResourceUrl, onCollectResourceUrlChange, onSelectionReadyChange }: ComponentProps<typeof ResourceConfiguratorHost>) => {
    useEffect(() => {
      onCollectResourceUrlChange?.(frame && initialResourceUrl ? async () => initialResourceUrl : null)
      onSelectionReadyChange?.(Boolean(frame && initialResourceUrl))
    }, [frame, initialResourceUrl, onCollectResourceUrlChange, onSelectionReadyChange])
    return frame ? <output data-testid="configurator">{initialResourceUrl ?? 'Generic MCP configurator'}</output> : null
  },
}))

const resource: SupportedResource = { urlPattern: 'https://*', title: 'Any MCP server', description: 'Connect tools from an MCP server.' }
const vendor = { id: 'mcp', description: { displayName: 'MCP Server', url: 'https://modelcontextprotocol.io' }, supportedResources: [resource] }
const tavily = 'https://mcp.tavily.com/mcp'
const firecrawl = 'https://mcp.firecrawl.dev/v2/mcp-oauth'
const account = (id: number, endpoint: string, credentialsValid = true): AccountOption => ({
  id, vendorId: 'mcp', vendorDescription: vendor.description, supportedResources: [resource], credentialsValid,
  description: { displayName: endpoint, uniqueName: endpoint, avatar: { url: '' } },
})
let vendors = [vendor]
let accounts: AccountOption[] = []
const disposeFrame = vi.fn<() => void>()
const disposeSubscription = vi.fn<() => void>()
const api = {
  listModels: async () => [],
  listGatekeeperVendors: async () => vendors,
  subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
    for (const a of accounts) subscriber.add(a.id, a.description, a.vendorDescription, a.supportedResources, a.credentialsValid, a.vendorId)
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: disposeSubscription })
  },
  startResourceConfigurator: vi.fn<(...args: Parameters<AuthenticatedApi['startResourceConfigurator']>) => Promise<{ ui: Disposable }>>(async () => ({ ui: { [Symbol.dispose]: disposeFrame } })),
  connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://example.test/gatekeeper/mcp/account/nonce?state=keep' })),
  ensureAccountResources: vi.fn<AuthenticatedApi['ensureAccountResources']>(async () => ({})),
}
const newGatekeeper = vi.fn<(...args: Parameters<Overseer['newGatekeeper']>) => Promise<Disposable>>(async () => ({ [Symbol.dispose]: vi.fn<() => void>() }))
const getOverseer = vi.fn<GatekeeperModalProps['getOverseer']>(() => ({ newGatekeeper }) as unknown as RpcStub<Overseer>)
const onCreated = vi.fn<GatekeeperModalProps['onCreated']>(async () => {})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Create New Connection personal search entries', () => {
  let root: Root
  let container: HTMLDivElement
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
  const click = async (text: string) => {
    const button = buttons().find(node => node.textContent?.trim() === text)
    expect(button, `button ${text}`).toBeDefined()
    await act(async () => button!.click())
  }
  const render = async (props: Partial<GatekeeperModalProps> = {}) => {
    await act(async () => root.render(<GatekeeperModal open onClose={() => {}} getOverseer={getOverseer} onCreated={onCreated} {...props} />))
  }
  const select = async (name: string) => {
    const group = buttons().find(node => node.hasAttribute('aria-expanded') && node.querySelector('p')?.textContent === name)
    expect(group).toBeDefined()
    await act(async () => group!.click())
    const entry = buttons().find(node => !node.hasAttribute('aria-expanded') && node.querySelector('p')?.textContent?.startsWith(name))
    expect(entry).toBeDefined()
    await act(async () => entry!.click())
  }
  beforeEach(() => {
    vendors = [vendor]
    accounts = [account(1, tavily), account(2, firecrawl), account(3, 'https://other.test/mcp'), account(4, `${tavily}.evil.test`)]
    vi.clearAllMocks()
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

  it.each([['Tavily', tavily, 'tavily_search', 1], ['Firecrawl', firecrawl, 'firecrawl_search', 2]] as const)(
    'offers %s with its logo, matching account and search-only prefill', async (name, endpoint, tool, id) => {
      await render()
      const group = buttons().find(node => node.hasAttribute('aria-expanded') && node.querySelector('p')?.textContent === name)!
      expect(group.querySelector('img')?.src).toMatch(/^data:image\/svg\+xml,/)
      await select(name)
      expect(buttons().filter(node => node.textContent?.includes('https://')).map(node => node.textContent)).toHaveLength(1)
      expect(buttons().some(node => node.textContent?.includes(endpoint))).toBe(true)
      expect(api.startResourceConfigurator).toHaveBeenLastCalledWith(id, 'https://*')
      expect(document.querySelector('output')?.textContent).toBe(`${endpoint}#tool=${tool}`)
      expect(newGatekeeper).not.toHaveBeenCalled()
      expect(api.connectAccount).not.toHaveBeenCalled()
      await click('Add connection')
      expect(newGatekeeper).toHaveBeenCalledExactlyOnceWith(id, `${endpoint}#tool=${tool}`)
      expect(onCreated).toHaveBeenCalledOnce()
    },
  )

  it.each(['Tavily', 'Firecrawl'])('connects a missing %s account through the real MCP vendor and preset', async name => {
    accounts = []
    await render()
    await select(name)
    expect(api.startResourceConfigurator).not.toHaveBeenCalled()
    await click(`Connect ${name}`)
    expect(api.connectAccount).toHaveBeenCalledExactlyOnceWith('mcp', undefined)
    expect(window.open).toHaveBeenCalledWith(`https://example.test/gatekeeper/mcp/account/nonce?state=keep&preset=${name.toLowerCase()}`, '_blank', 'noopener,noreferrer')
  })

  it.each([{ offered: [] }, { offered: [{ ...vendor, supportedResources: [] }] }])('hides shortcuts without the installed MCP resource', async ({ offered }) => {
    vendors = offered
    await render()
    expect(document.body.textContent).not.toContain('Tavily')
    expect(document.body.textContent).not.toContain('Firecrawl')
  })

  it('switches providers without reusing the other provider account or configurator', async () => {
    await render()
    await select('Tavily')
    await click('All connection types')
    await select('Firecrawl')
    expect(api.startResourceConfigurator).toHaveBeenLastCalledWith(2, 'https://*')
    expect(disposeFrame).toHaveBeenCalled()
    expect(document.querySelector('output')?.textContent).toBe(`${firecrawl}#tool=firecrawl_search`)
    expect(document.querySelector('[role="dialog"] section')?.textContent).not.toContain(tavily)
  })

  it('keeps generic MCP preselection and all its accounts unchanged', async () => {
    await render({ initialVendorId: 'mcp', initialResourceUrlPattern: 'https://*', initialResourceUrl: tavily })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Any MCP server')
    expect(buttons().filter(node => node.textContent?.includes('https://'))).toHaveLength(4)
    expect(document.querySelector('output')?.textContent).toBe('Generic MCP configurator')
  })

  it('does not automatically choose an expired search account', async () => {
    accounts = [account(1, tavily, false), account(2, firecrawl)]
    await render()
    await select('Tavily')
    expect(buttons().find(node => node.textContent?.includes(tavily))?.disabled).toBe(true)
    expect(api.startResourceConfigurator).not.toHaveBeenCalled()
    expect(buttons().find(node => node.textContent?.trim() === 'Add connection')?.disabled).toBe(true)
  })

  it('preserves canonical MCP grant requirements before loading the configurator', async () => {
    vendors = [{ ...vendor, supportedResources: [{ ...resource, grantable: true }] }]
    accounts = [{ ...account(1, tavily), description: { ...account(1, tavily).description, grantedResourceUrlPatterns: [] } }]
    await render()
    await select('Tavily')
    expect(api.startResourceConfigurator).not.toHaveBeenCalled()
    await click('Grant access')
    expect(api.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(1, ['https://*'])
    expect(newGatekeeper).not.toHaveBeenCalled()
  })
})
