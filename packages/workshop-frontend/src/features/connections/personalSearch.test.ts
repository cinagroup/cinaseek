import { describe, expect, it } from 'vitest'
import { PERSONAL_SEARCH_PROVIDERS, personalSearchProviderForUrl } from '@gadgets/workshop-shared/search-providers'
import { personalSearchBranding, personalSearchConnectUrl, personalSearchShortcut, withPersonalSearchShortcuts } from './personalSearch'

const mcp = { id: 'mcp', description: { displayName: 'MCP Server', url: 'https://modelcontextprotocol.io' }, supportedResources: [{ urlPattern: 'https://*', title: 'Any MCP server', description: 'Connect a server' }] }

describe('personal search entry points', () => {
  it('adds two branded shortcuts only when the HTTPS MCP resource is offered', () => {
    const vendors = withPersonalSearchShortcuts([mcp])
    expect(vendors.map(v => v.id)).toEqual(['mcp', 'mcp/tavily', 'mcp/firecrawl'])
    expect(vendors.slice(1).map(v => v.description.displayName)).toEqual(['Tavily', 'Firecrawl'])
    expect(vendors[1].description.logo?.url).not.toBe(vendors[2].description.logo?.url)
    for (const vendor of vendors.slice(1)) {
      expect(vendor.description.logo?.url).toMatch(/^data:image\/svg\+xml,/)
      expect(vendor.description.autoProvisionsAccount).toBeUndefined()
    }
    expect(withPersonalSearchShortcuts([])).toEqual([])
    expect(withPersonalSearchShortcuts([{ ...mcp, supportedResources: [] }])).toHaveLength(1)
    expect(withPersonalSearchShortcuts([{ ...mcp, supportedResources: [{ urlPattern: 'http://*', title: 'HTTP only', description: 'HTTP server' }] }])).toHaveLength(1)
  })

  it('keeps the backend vendor and nonce URL intact and adds only a fixed preset', () => {
    for (const provider of PERSONAL_SEARCH_PROVIDERS) {
      expect(personalSearchShortcut(`mcp/${provider.id}`)).toBe(provider)
      const url = new URL(personalSearchConnectUrl('https://example.com/gatekeeper/mcp/account/nonce', provider))
      expect(url.pathname).toBe('/gatekeeper/mcp/account/nonce')
      expect([...url.searchParams]).toEqual([['preset', provider.id]])
    }
    expect(personalSearchShortcut('tavily')).toBeUndefined()
    expect(personalSearchShortcut('mcp/unknown')).toBeUndefined()
  })

  it('brands existing accounts and tool URLs, never lookalike or credential-bearing URLs', () => {
    for (const provider of PERSONAL_SEARCH_PROVIDERS) {
      expect(personalSearchProviderForUrl(provider.endpoint + '/')).toBe(provider)
      expect(personalSearchBranding('mcp', provider.endpoint + `#tool=${provider.tool}`)?.name).toBe(provider.name)
      expect(personalSearchBranding('mcp-portal', provider.endpoint)).toBeUndefined()
    }
    for (const url of [undefined, 'not-a-url', 'https://mcp.tavily.com.evil.test/mcp',
      'https://user:password@mcp.tavily.com/mcp', 'https://mcp.tavily.com/mcp?api_key=x',
      'https://mcp.tavily.com/other', 'http://mcp.tavily.com/mcp', 'https://mcp.tavily.com/mcp//']) {
      expect(personalSearchBranding('mcp', url)).toBeUndefined()
    }
  })
})
