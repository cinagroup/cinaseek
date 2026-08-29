import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Hexagon, List, SidebarSimple, X } from '@phosphor-icons/react'
import TopBarNotice from '../../TopBarNotice'
import ReconnectingChip from '../ReconnectingChip'
import { useConnectionLost } from '../../RpcContext'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import { OPEN_COMMAND_PALETTE_EVENT } from './commandPaletteBus'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import AccessLoginController from '../AccessLoginModal'
import { useTranslation } from '../../i18n'
import { isCinaSeekDesktopShell } from '../../nativeShell'
import DesktopMenuBar from './DesktopMenuBar'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import { DEFAULT_SITE_NAME } from '@gadgets/workshop-shared/api'

const STORAGE_KEY_COLLAPSED = 'gadgets:sidebar-collapsed'

// Read synchronously for the initial state so the rail doesn't flash open then collapse.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === '1'
  } catch {
    return false
  }
}

/**
 * The authenticated, non-fullscreen application chrome: a persistent left rail + a thin top notice
 * strip + the routed content. Replaces the old <Header /> on these routes. Chat and Gadget editor
 * pages are still rendered fullscreen by __root.tsx without this shell.
 *
 * Mobile: below `md` the rail collapses to an overlay drawer triggered by a hamburger button in a
 * minimal top bar. We don't try to gracefully shrink the rail at narrow widths; the overlay model
 * is simpler and matches how the rest of the app handles small screens.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('shell')
  const auth = useOptionalAuthenticatedApi()
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const connectionLost = useConnectionLost()
  const desktopShell = isCinaSeekDesktopShell()
  const siteName = useSiteName()
  const customDeploymentName = siteName !== DEFAULT_SITE_NAME

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY_COLLAPSED, next ? '1' : '0') } catch {}
      return next
    })
  }, [])

  // Close mobile drawer when escape is pressed.
  useEffect(() => {
    if (!mobileOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : menuButtonRef.current
    drawerRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false)
        return
      }
      if (e.key !== 'Tab' || !drawerRef.current) return
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      window.setTimeout(() => previousFocus?.focus(), 0)
    }
  }, [mobileOpen])

  // Close the mobile drawer on navigation. Links in the drawer (primary nav, Gatekeepers, the user
  // menu, workspace rows) otherwise navigate while leaving the drawer covering the page — so on a
  // phone it looks like nothing happened. Watching the pathname catches every navigation source
  // without prop-drilling a close callback through the whole rail. No-op on desktop, where the
  // drawer is never open.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // Global ⌘K / Ctrl+K opens the command palette; the rail's search button opens it via a custom
  // event so it doesn't have to prop-drill into the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    const onOpen = () => setPaletteOpen(true)
    document.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-kumo-base">
      {/* Desktop sidebar — hidden on mobile in favor of the drawer. */}
      <div className="hidden h-full md:flex">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          collapseControlInTopBar={desktopShell}
        />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Primary navigation"
            tabIndex={-1}
            className="fixed inset-y-0 left-0 z-50 outline-none md:hidden"
          >
            <Sidebar collapsed={false} onToggleCollapsed={() => setMobileOpen(false)} />
          </div>
        </>
      )}

      {/* Main column */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        inert={mobileOpen ? true : undefined}
        aria-hidden={mobileOpen ? true : undefined}
      >
        {/* Top bar. Same height as the sidebar's brand row (h-14) so they read as one continuous
            chrome strip across the top. Mostly empty — carries the mobile hamburger on the left,
            any admin TopBarNotice centered, and the reconnecting chip on the right. */}
        <div className={`relative flex h-14 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base ${desktopShell ? 'cinaseek-desktop-titlebar pl-2 pr-3' : 'px-3'}`}>
          <div className="cinaseek-desktop-no-drag flex items-center gap-1">
            <button
              type="button"
              ref={menuButtonRef}
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? t('sidebar.closeMenu') : t('sidebar.openMenu')}
              className="flex h-11 w-11 items-center justify-center rounded-md text-kumo-default transition-colors hover:bg-kumo-tint md:hidden"
            >
              {mobileOpen ? <X size={16} /> : <List size={16} />}
            </button>
            <Link
              to="/"
              aria-label={siteName}
              className="flex min-w-0 items-center gap-2 md:hidden"
            >
              <SiteLogo size={20} className="shrink-0">
                <Hexagon size={20} weight="bold" className="shrink-0 text-kumo-brand" />
              </SiteLogo>
              <span className="min-w-0">
                <span className="block truncate text-[14px] leading-4 font-semibold tracking-[-0.25px] text-kumo-default">
                  {siteName}
                </span>
                {customDeploymentName && (
                  <span className="block truncate text-[10px] leading-3 text-kumo-inactive">
                    {t('brand.poweredBy')}
                  </span>
                )}
              </span>
            </Link>
            {desktopShell ? (
              <>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                  title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                  className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded-[3px] text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default md:flex"
                >
                  <SidebarSimple size={15} className={collapsed ? 'rotate-180' : ''} />
                </button>
                <DesktopMenuBar />
              </>
            ) : null}
          </div>
          <TopBarNotice />
          {/* `ml-auto` rather than the container's `justify-between`: on desktop the hamburger is
              hidden, leaving this the only in-flow child, which `justify-between` would park on the
              left. */}
          <div className="ml-auto flex items-center gap-2">
            {connectionLost && <ReconnectingChip />}
            <span aria-hidden="true" className="h-11 w-11 md:hidden" />
          </div>
        </div>

        {/* Routed content. Flat enterprise canvas — no texture. */}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {auth ? <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} /> : null}
      {auth ? null : <AccessLoginController />}
    </div>
  )
}
