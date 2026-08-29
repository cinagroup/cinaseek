import { useEffect, type MouseEvent } from 'react'
import { useTheme } from '../../ThemeContext'

const MENUS = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
] as const

function openDesktopMenu(
  menuId: (typeof MENUS)[number]['id'],
  event: MouseEvent<HTMLButtonElement>,
) {
  const rect = event.currentTarget.getBoundingClientRect()
  window.cinaseekDesktop?.openMenu(menuId, {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  })
}

/** Native desktop menus anchored to HTML triggers in the integrated title bar. */
export default function DesktopMenuBar() {
  const { resolvedThemeMode } = useTheme()

  useEffect(() => {
    window.cinaseekDesktop?.setTheme(resolvedThemeMode)
  }, [resolvedThemeMode])

  return (
    <nav aria-label="Application menu" className="cinaseek-desktop-no-drag flex items-center gap-0.5">
      {MENUS.map((menu) => (
        <button
          key={menu.id}
          type="button"
          aria-haspopup="menu"
          onClick={(event) => openDesktopMenu(menu.id, event)}
          className="flex h-7 items-center rounded-[3px] px-2 text-[13px] font-normal text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-brand"
        >
          {menu.label}
        </button>
      ))}
    </nav>
  )
}
