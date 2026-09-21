import { PERSONAL_SEARCH_PROVIDERS, personalSearchProviderForUrl, type PersonalSearchProvider } from '@gadgets/workshop-shared/search-providers'
import type { SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import tavilyLogo from './tavily.svg?raw'
import firecrawlLogo from './firecrawl.svg?raw'
import { i18n } from '../../i18n'

const logos = {
  // Keep the supplied mark intact, on its approved backdrop even in inline chat mentions.
  tavily: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 55 55"><rect width="55" height="55" fill="#FFFCF6"/>${tavilyLogo}</svg>`)}`,
  firecrawl: `data:image/svg+xml,${encodeURIComponent(firecrawlLogo)}`,
}

export const personalSearchBranding = (vendorId: string | undefined, url: string | undefined) => {
  const provider = vendorId === 'mcp' ? personalSearchProviderForUrl(url) : undefined
  return provider && {
    logoUrl: logos[provider.id],
    // Tavily's unmodified black mark needs its approved light backdrop in either app theme.
    color: provider.id === 'tavily' ? '#FFFCF6' : undefined,
    name: provider.name,
  }
}

export const personalSearchDescription = (provider: PersonalSearchProvider): VendorDescription => ({
  displayName: provider.name,
  url: provider.id === 'tavily' ? 'https://www.tavily.com' : 'https://www.firecrawl.dev',
  logo: { url: logos[provider.id] },
  color: personalSearchBranding('mcp', provider.endpoint)?.color,
  tagline: i18n.t('gatekeepers:personalSearch.tagline'),
  description: i18n.t('gatekeepers:personalSearch.description'),
})

export const personalSearchShortcut = (id: string) =>
  PERSONAL_SEARCH_PROVIDERS.find(provider => id === `mcp/${provider.id}`)

type AvailableVendor = { id: string; description: VendorDescription; supportedResources: SupportedResource[] }

export const withPersonalSearchShortcuts = (vendors: AvailableVendor[]): AvailableVendor[] => {
  // This is the resource advertised by the installed MCP worker. No backend offer, no shortcuts.
  const mcp = vendors.find(vendor => vendor.id === 'mcp')
  if (!mcp?.supportedResources.some(resource => resource.urlPattern === 'https://*')) return vendors
  return [...vendors, ...PERSONAL_SEARCH_PROVIDERS.map(provider => ({
    id: `mcp/${provider.id}`,
    description: personalSearchDescription(provider),
    supportedResources: [{
      urlPattern: provider.endpoint,
      title: i18n.t('gatekeepers:personalSearch.resourceTitle', { provider: provider.name }),
      description: i18n.t('gatekeepers:personalSearch.resourceDescription'),
      icon: { url: logos[provider.id] },
    }],
  }))]
}

export const personalSearchConnectUrl = (url: string, provider: PersonalSearchProvider): string => {
  const target = new URL(url)
  target.searchParams.set('preset', provider.id)
  return target.toString()
}
