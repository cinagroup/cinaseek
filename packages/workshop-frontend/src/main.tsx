import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { RpcStub, newWebSocketRpcSession } from 'capnweb'
import { PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyAccentColor, applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { applySiteFavicon, cacheBustSiteLogoUrl } from './siteLogoUtils'
import { probeAccessSession, type AccessSessionStatus } from './accessSession'
import { initializeI18n } from './i18n'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

// ---------------------------------------------------------------------------
// Dev auto-login: if VITE_DEV_AUTO_LOGIN=true, automatically create/login
// with the dev account before React renders, so you never see the login page.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return  // already logged in

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'

  // Derive the passwordHash the same way the app does (argon2id via hashPassword),
  // but here we use the same SERVICE_SALT + SHA-256 shortcut that wrangler dev accepts
  // in local mode. We import hashPassword from the existing util.
  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  // Try createAccount first — works on a fresh backend. Returns null if already exists.
  let token = await stub.createAccount(username, username, passwordHash)

  // If null, account already exists — just log in.
  if (!token) {
    token = await stub.login(username, passwordHash)
  }

  if (token) {
    localStorage.setItem('authToken', token)
  }
}

// WebSocket RPC connection management.
//
// React's useEffect / useState machinery is kind of obnoxious in that, in dev mode, it runs
// everything twice (runs once, immediately cleans up, then runs again). This isn't so good for
// our WebSocket as it means we are creating redundant connections to the server and throwing
// them away instantly. It gets even worse when we start trying to handle disconnects gracefully:
// we can end up with two connections that are fighting to replace each other.
//
// Or maybe I (Kenton) was just holding it wrong, idk.
//
// Anyway, I pulled the connection management out into these globals instead.
let lastConnectTime: number = 0;
let backoff: number = 1000;

function getBackendHost(): string {
  const backendHost = import.meta.env.VITE_BACKEND_HOST?.trim();
  if (backendHost) return backendHost;

  // When opening the Vite dev server directly (localhost:3000), the backend is at localhost:8787.
  // Otherwise, the API is on the same host as the frontend.
  return window.location.hostname === 'localhost' ? 'localhost:8787' : window.location.host;
}

function startConnection(): RpcStub<PublicApi> {
  lastConnectTime = Date.now();
  const apiHost = getBackendHost();
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api';
  return newWebSocketRpcSession<PublicApi>(wsUrl);
}

function notifyConnectionStateChanged() {
  for (const cb of notifyCurrentStubUpdated) cb()
}

function openConnection(): RpcStub<PublicApi> {
  const stub = startConnection()
  stub.onRpcBroken((error) => handleBroken(stub, error))
  return stub
}

async function handleBroken(brokenStub: RpcStub<PublicApi>, error: unknown) {
  if (currentStub !== brokenStub) return
  console.warn('RPC connection lost:', error);

  isConnectionLost = true;
  notifyConnectionStateChanged()

  // A public shell must not reconnect forever after the Access application session expires.
  // Re-check the protected HTTP endpoint first; a guest transition tears down the RPC state while
  // a transient probe failure keeps the ordinary reconnect path alive.
  if (CF_ACCESS_MODE) {
    const status = await probeAccessSession()
    if (currentStub !== brokenStub) return
    if (status === 'guest') {
      currentStub = null
      accessSessionStatus = 'guest'
      isConnectionLost = false
      notifyConnectionStateChanged()
      return
    }
    if (status === 'authenticated') accessSessionStatus = 'authenticated'
  }

  let timeSinceConnect = Date.now() - lastConnectTime;
  if (timeSinceConnect < backoff) {
    let waitTime = backoff - timeSinceConnect;
    console.warn(`Will try again in ${Math.round(waitTime / 1000)} seconds...`)
    await new Promise(resolve => setTimeout(resolve, waitTime));
    console.warn(`Retrying connection...`);
    backoff = Math.min(backoff * 2, 10000);
  } else {
    backoff = 1000;
  }

  if (currentStub !== brokenStub) return
  currentStub = openConnection();

  // Don't clear isConnectionLost here — the new connection hasn't proven
  // it works yet. It gets cleared by markConnectionRestored() once the
  // app successfully communicates with the backend.
  notifyConnectionStateChanged()
}

// Callbacks to call whenever `currentStub` or connection state is updated.
let notifyCurrentStubUpdated: Set<() => void> = new Set();
let isConnectionLost = false;
let currentStub: RpcStub<PublicApi> | null = null
let accessSessionStatus: AccessSessionStatus = CF_ACCESS_MODE ? 'checking' : 'not-applicable'
let accessSessionInitialization: Promise<void> | null = null

function initializeAccessSession(): Promise<void> {
  if (!CF_ACCESS_MODE) return Promise.resolve()
  if (accessSessionInitialization) return accessSessionInitialization

  accessSessionInitialization = probeAccessSession().then((status) => {
    accessSessionStatus = status
    if (status === 'authenticated' && !currentStub) currentStub = openConnection()
    notifyConnectionStateChanged()
  })
  return accessSessionInitialization
}

// Called externally (e.g., by auth) to indicate the connection is alive.
export function markConnectionRestored() {
  if (!isConnectionLost) return;
  isConnectionLost = false;
  for (let cb of notifyCurrentStubUpdated) { cb(); }
}

// Current stub. handleBroken() will replace this on disconnect.
installWorkshopErrorReporting()
if (!CF_ACCESS_MODE) currentStub = openConnection()

const router = createRouter()
applyStoredThemeMode()

function AppWithConnection() {
  const [rpcState, setRpcState] = useState<{
    stub: RpcStub<PublicApi> | null
    connectionLost: boolean
    accessSessionStatus: AccessSessionStatus
  }>({
    stub: currentStub,
    connectionLost: isConnectionLost,
    accessSessionStatus,
  });
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverConfigError, setServerConfigError] = useState(false);

  useEffect(() => {
    const cb = () => setRpcState({
      stub: currentStub,
      connectionLost: isConnectionLost,
      accessSessionStatus,
    });
    notifyCurrentStubUpdated.add(cb);
    void initializeAccessSession()
    return () => { notifyCurrentStubUpdated.delete(cb); };
  }, []);

  // Fetch deployment config once the (re)connected stub is available. Re-fetch on reconnect so a
  // server restart with changed config is picked up.
  useEffect(() => {
    if (!rpcState.stub) {
      setServerConfig(null)
      setServerConfigError(false)
      return
    }
    let cancelled = false;
    setServerConfigError(false);
    rpcState.stub.getServerConfig()
      .then((cfg) => {
        if (!cancelled) {
          setServerConfig(cfg.siteLogo ? {
            ...cfg,
            siteLogo: { url: cacheBustSiteLogoUrl(cfg.siteLogo.url) },
          } : cfg);
        }
      })
      .catch(() => { if (!cancelled) setServerConfigError(true); });
    return () => { cancelled = true; };
  }, [rpcState.stub]);

  // Apply the deployment's admin-chosen accent color (overrides brand CSS vars at runtime).
  useEffect(() => {
    applyAccentColor(serverConfig?.accentColor ?? '');
  }, [serverConfig?.accentColor]);

  useEffect(() => {
    return applySiteFavicon(serverConfig?.siteLogo?.url);
  }, [serverConfig]);

  return (
    <ThemeProvider>
      <RpcContext.Provider value={rpcState}>
        <ServerConfigErrorContext.Provider value={serverConfigError}>
          <ServerConfigContext.Provider value={serverConfig}>
            <AnnouncementBanner />
            <RouterProvider router={router} />
          </ServerConfigContext.Provider>
        </ServerConfigErrorContext.Provider>
      </RpcContext.Provider>
    </ThemeProvider>
  );
}

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop.react-root', error, {
    handled: false, severity: 'fatal', captureMechanism: 'react',
  }),
})

// Kick off dev auto-login in the background. If it completes before
// useAuth checks the token, the user skips the login page. If the backend
// is unreachable, the app still renders immediately (showing a connection
// banner or login page) instead of hanging on a blank screen.
if (currentStub) devAutoLogin(currentStub).catch(() => {})

function renderApplication() {
  root.render(
    <StrictMode>
      <FrontendErrorBoundary>
        <AppWithConnection />
      </FrontendErrorBoundary>
    </StrictMode>
  )
}

// Resolve and load the selected catalog before the first paint, preventing an English-to-localized
// flash. English is bundled as the reliable fallback; non-default catalogs are split by Vite.
initializeI18n()
  .catch((error) => reportIssue('workshop.i18n.initialize', error, {
    handled: true, severity: 'warning', captureMechanism: 'explicit',
  }))
  .finally(renderApplication)
