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
  type DesktopMenuLocale,
} from './desktop-menu-protocol.js'
import { mayUseCinaSeekPermission } from './permission-policy.js'

const SESSION_PARTITION = 'persist:cinaseek'
const DESKTOP_MENU_CHANNEL = 'cinaseek:desktop-menu:open'
const DESKTOP_THEME_CHANNEL = 'cinaseek:desktop-theme:set'
const DESKTOP_TITLE_BAR_HEIGHT = 56
const PRELOAD_SCRIPT = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'logo.png')
  : fileURLToPath(new URL('../build/logo-rounded-3px.png', import.meta.url))
const MAIN_WINDOW_BACKGROUND = '#f4fbfd'
const TITLE_BAR_COLORS = {
  light: { color: '#fcfcfb', symbolColor: '#1c1a18' },
  dark: { color: '#1b1920', symbolColor: '#f0eef3' },
} as const
const DESKTOP_MENU_LABELS = {
  en: {
    newWindow: 'New Window', openInBrowser: 'Open in Browser', closeWindow: 'Close Window', exit: 'Exit',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    reload: 'Reload', actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullScreen: 'Toggle Full Screen',
    home: 'CinaSeek Home', privacy: 'Privacy', security: 'Security', support: 'Support', report: 'Report an Issue',
    about: 'About CinaSeek', version: 'Version', product: 'A CinaGroup product', ok: 'OK',
  },
  'zh-CN': {
    newWindow: '新建窗口', openInBrowser: '在浏览器中打开', closeWindow: '关闭窗口', exit: '退出',
    undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    reload: '重新加载', actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullScreen: '切换全屏',
    home: 'CinaSeek 首页', privacy: '隐私', security: '安全', support: '支持', report: '报告问题',
    about: '关于 CinaSeek', version: '版本', product: 'CinaGroup 旗下产品', ok: '确定',
  },
  'zh-TW': {
    newWindow: '新增視窗', openInBrowser: '在瀏覽器中開啟', closeWindow: '關閉視窗', exit: '結束',
    undo: '還原', redo: '重做', cut: '剪下', copy: '複製', paste: '貼上', selectAll: '全選',
    reload: '重新載入', actualSize: '實際大小', zoomIn: '放大', zoomOut: '縮小', fullScreen: '切換全螢幕',
    home: 'CinaSeek 首頁', privacy: '隱私', security: '安全', support: '支援', report: '回報問題',
    about: '關於 CinaSeek', version: '版本', product: 'CinaGroup 旗下產品', ok: '確定',
  },
} as const

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
  appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    mayUseCinaSeekPermission(
      permission,
      details.requestingUrl ?? requestingOrigin,
      details.mediaType ? [details.mediaType] : [],
    ),
  )
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = permission === 'media' && 'mediaTypes' in details
      ? details.mediaTypes ?? []
      : []
    callback(mayUseCinaSeekPermission(
      permission,
      details.requestingUrl ?? contents.getURL(),
      mediaTypes,
    ))
  })
  appSession.setDevicePermissionHandler(() => false)
}

function createDesktopMenuTemplate(
  menuId: DesktopMenuId,
  window: BrowserWindow,
  locale: DesktopMenuLocale,
): MenuItemConstructorOptions[] {
  const label = DESKTOP_MENU_LABELS[locale]
  switch (menuId) {
    case 'file':
      return [
        { label: label.newWindow, accelerator: 'CmdOrCtrl+N', click: () => createMainWindow() },
        {
          label: label.openInBrowser,
          click: () => openInSystemBrowser(currentAppPageWithoutCredentials(window)),
        },
        { type: 'separator' },
        { label: label.closeWindow, role: 'close' },
        { label: label.exit, role: 'quit' },
      ]
    case 'edit':
      return [
        { label: label.undo, role: 'undo' },
        { label: label.redo, role: 'redo' },
        { type: 'separator' },
        { label: label.cut, role: 'cut' },
        { label: label.copy, role: 'copy' },
        { label: label.paste, role: 'paste' },
        { label: label.selectAll, role: 'selectAll' },
      ]
    case 'view':
      return [
        { label: label.reload, role: 'reload' },
        { type: 'separator' },
        { label: label.actualSize, role: 'resetZoom' },
        { label: label.zoomIn, role: 'zoomIn' },
        { label: label.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: label.fullScreen, role: 'togglefullscreen' },
      ]
    case 'help':
      return [
        { label: label.home, click: () => openInSystemBrowser(CINASEEK_APP_ORIGIN) },
        { label: label.privacy, click: () => openInSystemBrowser(`${CINASEEK_APP_ORIGIN}/legal/privacy`) },
        { label: label.security, click: () => openInSystemBrowser(`${CINASEEK_APP_ORIGIN}/security`) },
        { label: label.support, click: () => openInSystemBrowser(`${CINASEEK_APP_ORIGIN}/support`) },
        {
          label: label.report,
          click: () => openExternalUrl('https://github.com/cinagroup/cinaseek/issues'),
        },
        { type: 'separator' },
        {
          label: label.about,
          click: () => {
            void dialog.showMessageBox(window, {
              type: 'info',
              title: label.about,
              message: 'CinaSeek',
              detail: `${label.version} ${app.getVersion()}\n${label.product}\nhttps://cinaseek.ai`,
              buttons: [label.ok],
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

    const menu = Menu.buildFromTemplate(createDesktopMenuTemplate(request.menuId, window, request.locale))
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
