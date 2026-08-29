import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  Menu,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron'
import {
  CINASEEK_APP_ORIGIN,
  isCinaSeekAppUrl,
  isSafeExternalUrl,
  isSecureWebUrl,
} from './navigation-policy.js'

const SESSION_PARTITION = 'persist:cinaseek'
const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'logo.png')
  : fileURLToPath(new URL('../../app-mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url))
const MAIN_WINDOW_BACKGROUND = '#f4fbfd'
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
  } satisfies NonNullable<BrowserWindowConstructorOptions['webPreferences']>
}

function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) return
  void shell.openExternal(url).catch(() => {})
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
