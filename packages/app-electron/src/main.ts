import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import {
  CINASEEK_APP_ORIGIN,
  isCinaSeekAppUrl,
  isSafeExternalUrl,
  isSecureWebUrl,
  safeCinaSeekBrowserUrl,
} from './navigation-policy.js'
import {
  parseDesktopMenuRequest,
  type DesktopMenuId,
} from './desktop-menu-protocol.js'

const SESSION_PARTITION = 'persist:cinaseek'
const DESKTOP_MENU_CHANNEL = 'cinaseek:desktop-menu:open'
const DESKTOP_THEME_CHANNEL = 'cinaseek:desktop-theme:set'
const DESKTOP_TITLE_BAR_HEIGHT = 56
const PRELOAD_SCRIPT = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'logo.png')
  : fileURLToPath(new URL('../../app-mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url))
const MAIN_WINDOW_BACKGROUND = '#f4fbfd'
const TITLE_BAR_COLORS = {
  light: { color: '#fcfcfb', symbolColor: '#1c1a18' },
  dark: { color: '#1b1920', symbolColor: '#f0eef3' },
} as const
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

function secureWebPreferences() {
  return {
    partition: SESSION_PARTITION,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    devTools: !app.isPackaged,
    spellcheck: true,
    preload: PRELOAD_SCRIPT,
  } satisfies NonNullable<BrowserWindowConstructorOptions['webPreferences']>
}

function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) return
  void shell.openExternal(url).catch(() => {})
}

function openInSystemBrowser(url: string): void {
  if (!isSecureWebUrl(url)) return
  void shell.openExternal(url).catch(() => {})
}

function currentAppPageWithoutCredentials(window: BrowserWindow): string {
  return safeCinaSeekBrowserUrl(window.webContents.getURL())
}

function configurePopup(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isSecureWebUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isSecureWebUrl(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
}

function configureMainWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (isCinaSeekAppUrl(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isCinaSeekAppUrl(url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isCinaSeekAppUrl(url)) {
      openExternalUrl(url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 560,
        height: 780,
        minWidth: 420,
        minHeight: 600,
        autoHideMenuBar: true,
        backgroundColor: MAIN_WINDOW_BACKGROUND,
        parent: window,
        icon: APP_ICON,
        webPreferences: secureWebPreferences(),
      },
    }
  })
  window.webContents.on('did-create-window', (child) => configurePopup(child.webContents))
}

function configureSession(): void {
  const appSession = session.fromPartition(SESSION_PARTITION)
  appSession.setUserAgent(`${appSession.getUserAgent()} CinaSeekDesktop/${app.getVersion()}`)
  const mayUsePermission = (permission: string, requestingUrl: string): boolean =>
    ALLOWED_PERMISSIONS.has(permission) && isCinaSeekAppUrl(requestingUrl)

  appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    mayUsePermission(permission, details.requestingUrl ?? requestingOrigin),
  )
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(mayUsePermission(permission, details.requestingUrl ?? contents.getURL()))
  })
  appSession.setDevicePermissionHandler(() => false)
}

function createDesktopMenuTemplate(
  menuId: DesktopMenuId,
  window: BrowserWindow,
): MenuItemConstructorOptions[] {
  switch (menuId) {
    case 'file':
      return [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createMainWindow() },
        {
          label: 'Open in Browser',
          click: () => openInSystemBrowser(currentAppPageWithoutCredentials(window)),
        },
        { type: 'separator' },
        { label: 'Close Window', role: 'close' },
        { label: 'Exit', role: 'quit' },
      ]
    case 'edit':
      return [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ]
    case 'view':
      return [
        { label: 'Reload', role: 'reload' },
        { type: 'separator' },
        { label: 'Actual Size', role: 'resetZoom' },
        { label: 'Zoom In', role: 'zoomIn' },
        { label: 'Zoom Out', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
      ]
    case 'help':
      return [
        { label: 'CinaSeek Home', click: () => openInSystemBrowser(CINASEEK_APP_ORIGIN) },
        {
          label: 'Report an Issue',
          click: () => openExternalUrl('https://github.com/cinagroup/cinaseek/issues'),
        },
        { type: 'separator' },
        {
          label: 'About CinaSeek',
          click: () => {
            void dialog.showMessageBox(window, {
              type: 'info',
              title: 'About CinaSeek',
              message: 'CinaSeek',
              detail: `Version ${app.getVersion()}\nhttps://cinaseek.ai`,
              buttons: ['OK'],
            })
          },
        },
      ]
  }
}

function isTrustedRenderer(contents: WebContents): boolean {
  return !contents.isDestroyed() && isCinaSeekAppUrl(contents.getURL())
}

function registerDesktopShellIpc(): void {
  ipcMain.on(DESKTOP_MENU_CHANNEL, (event, value: unknown) => {
    if (!isTrustedRenderer(event.sender)) return
    const window = BrowserWindow.fromWebContents(event.sender)
    const request = parseDesktopMenuRequest(value)
    if (!window || !request) return

    const menu = Menu.buildFromTemplate(createDesktopMenuTemplate(request.menuId, window))
    menu.popup({
      window,
      x: request.anchor.x,
      y: request.anchor.y + request.anchor.height,
    })
  })

  ipcMain.on(DESKTOP_THEME_CHANNEL, (event, theme: unknown) => {
    if (!isTrustedRenderer(event.sender) || (theme !== 'light' && theme !== 'dark')) return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || process.platform !== 'win32') return
    window.setTitleBarOverlay({
      ...TITLE_BAR_COLORS[theme],
      height: DESKTOP_TITLE_BAR_HEIGHT,
    })
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'CinaSeek',
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: MAIN_WINDOW_BACKGROUND,
    icon: APP_ICON,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        ...TITLE_BAR_COLORS.light,
        height: DESKTOP_TITLE_BAR_HEIGHT,
      },
    } : {}),
    webPreferences: secureWebPreferences(),
  })
  configureMainWindow(window)
  window.once('ready-to-show', () => window.show())
  void window.loadURL(CINASEEK_APP_ORIGIN).catch(() => window.show())
  return window
}

app.enableSandbox()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    configureSession()
    registerDesktopShellIpc()
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    mainWindow = createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
