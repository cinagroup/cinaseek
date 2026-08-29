import { contextBridge, ipcRenderer } from 'electron'

const MENU_CHANNEL = 'cinaseek:desktop-menu:open'
const THEME_CHANNEL = 'cinaseek:desktop-theme:set'
const MENU_IDS = new Set(['file', 'edit', 'view', 'help'])
const MENU_LOCALES = new Set(['en', 'zh-CN', 'zh-TW'])

type MenuAnchor = { x: number; y: number; width: number; height: number }

function validAnchor(anchor: MenuAnchor): boolean {
  return [anchor.x, anchor.y, anchor.width, anchor.height]
    .every((item) => typeof item === 'number' && Number.isFinite(item))
    && anchor.width >= 0
    && anchor.height >= 0
}

contextBridge.exposeInMainWorld('cinaseekDesktop', Object.freeze({
  openMenu(menuId: string, anchor: MenuAnchor, locale: string): void {
    if (!MENU_IDS.has(menuId) || !validAnchor(anchor)) return
    ipcRenderer.send(MENU_CHANNEL, {
      menuId,
      anchor,
      locale: MENU_LOCALES.has(locale) ? locale : 'en',
    })
  },
  setTheme(theme: string): void {
    if (theme !== 'light' && theme !== 'dark') return
    ipcRenderer.send(THEME_CHANNEL, theme)
  },
}))
