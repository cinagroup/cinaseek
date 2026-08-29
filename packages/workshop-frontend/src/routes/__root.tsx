import { logRpcFailure } from '../rpcErrors'
import { useState, useEffect } from 'react'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useRpcContext } from '../RpcContext'
import { useAuth, CF_ACCESS_MODE } from '../useAuth'
import { AuthProvider } from '../AuthContext'
import { FeatureFlagsProvider } from '../FeatureFlagsContext'
import Header from '../components/Header'
import AppShell from '../components/AppShell/AppShell'
import LoginPage from '../LoginPage'
import OnboardingWizard from '../OnboardingWizard'
import AccountSelectionModal from '../components/billing/AccountSelectionModal'
import { beginAccessLogin, currentReturnTo } from '../accessSession'
import { AccessLoginComplete } from '../components/AccessLoginModal'
import { useTranslation } from '../i18n'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const { t } = useTranslation(['shell', 'common'])
  const { stub: rpcStub, connectionLost, accessSessionStatus } = useRpcContext()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } =
    useAuth(rpcStub, accessSessionStatus)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Routes that don't require auth (public routes)
  const isSignup = pathname === '/signup'
  const isBlueprint = pathname.startsWith('/blueprint/')
  const isTrustPage = pathname === '/legal/privacy' || pathname === '/legal/terms' ||
    pathname === '/security' || pathname === '/support'

  // A standalone (no app shell) render is used only for signed-out visitors of public routes.
  // Signed-in users get the full app chrome so public pages (esp. the blueprint detail) feel
  // native — sidebar and all — instead of floating on a bare page.
  const standalone = isTrustPage || (!CF_ACCESS_MODE && (isSignup || (isBlueprint && !isAuthenticated)))
  const publicGuestHome = CF_ACCESS_MODE && pathname === '/' && !isAuthenticated
  const accessLoginComplete = CF_ACCESS_MODE && pathname === '/auth/complete'

  // The workspace editor renders fullscreen (no app chrome). /gadget/ is the legacy URL, kept
  // here so the chrome doesn't flash in during the redirect to /workspace/.
  const isWorkspaceEditor = pathname.startsWith('/workspace/') || pathname.startsWith('/gadget/')

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  if (accessLoginComplete) {
    return <AccessLoginComplete status={accessSessionStatus} />
  }

  // Loading state
  if (isLoading && !standalone && !publicGuestHome) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-kumo-subtle">
          {connectionLost ? t('shell:status.waitingForServer') : t('shell:status.loading')}
        </p>
      </div>
    )
  }

  // Auth error
  if (error && !standalone && !publicGuestHome) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base p-6">
        <p className="text-sm text-kumo-danger">{t('shell:status.authenticationError', { error })}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    )
  }

  // The home shell is public in Access mode. Capability-bearing controls remain unavailable until
  // the protected session probe and RPC authentication both succeed.
  if (publicGuestHome) {
    return (
      <TooltipProvider>
        <Toasty>
          <AppShell>
            <Outlet />
          </AppShell>
        </Toasty>
      </TooltipProvider>
    )
  }

  // Client-side routing cannot trigger an Access challenge, so protected routes use a real
  // document navigation while the home page keeps the hybrid popup experience.
  if (!isAuthenticated && CF_ACCESS_MODE && !standalone) return <AccessLoginRedirect />

  // Not authenticated and not a public route — show login
  if (!isAuthenticated && !standalone) {
    if (!rpcStub) return null
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  // Signed-out visitors of public routes render without the auth wrapper / app shell.
  if (standalone) {
    const showHeader = !isSignup
    return (
      <TooltipProvider>
        <Toasty>
          <div className="flex h-full min-h-0 flex-col">
            {showHeader && <Header />}
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </Toasty>
      </TooltipProvider>
    )
  }

  // Authenticated — render the full shell (with onboarding gate)
  // authenticatedApi is guaranteed non-null here: isLoading, error, and
  // !isAuthenticated branches all return early above.
  if (!authenticatedApi) return null
  return (
    <AuthProvider authenticatedApi={authenticatedApi} onLogout={logout}>
      <FeatureFlagsProvider>
        <TooltipProvider>
          <Toasty>
            <AuthenticatedShell
              authenticatedApi={authenticatedApi}
              isWorkspaceEditor={isWorkspaceEditor}
            />
          </Toasty>
        </TooltipProvider>
      </FeatureFlagsProvider>
    </AuthProvider>
  )
}

function AccessLoginRedirect() {
  const { t } = useTranslation('shell')
  useEffect(() => beginAccessLogin(currentReturnTo()), [])
  return (
    <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
      <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      <p className="text-sm text-kumo-subtle">{t('status.openingSignIn')}</p>
    </div>
  )
}

/**
 * Inner shell that checks onboarding status and either shows the wizard
 * or the normal app chrome. Lives inside AuthProvider so the wizard can
 * use useAuthenticatedApi().
 */
function AuthenticatedShell({
  authenticatedApi,
  isWorkspaceEditor,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  isWorkspaceEditor: boolean
}) {
  // null = still checking, true = needs onboarding, false = onboarding done
  const [onboardingNeeded, setOnboardingNeeded] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.isOnboardingCompleted().then((completed) => {
      if (!cancelled) setOnboardingNeeded(!completed)
    }).catch((err) => {
      logRpcFailure('Failed to check onboarding status:', err)
      // If the check fails, skip onboarding to avoid blocking the user
      if (!cancelled) setOnboardingNeeded(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Still checking onboarding status
  if (onboardingNeeded === null) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Show onboarding wizard
  if (onboardingNeeded) {
    return <OnboardingWizard onComplete={() => setOnboardingNeeded(false)} />
  }

  // Normal app shell. The workspace editor is rendered fullscreen (no chrome); everything else
  // gets the persistent left-rail AppShell. Connection loss is surfaced by a chip in whichever of
  // those two top bars is showing, never by a banner that reflows the page (see ReconnectingChip).
  const fullscreen = isWorkspaceEditor
  return (
    <>
      <AccountSelectionModal />
      {fullscreen ? (
        <main className="h-full min-h-0">
          <Outlet />
        </main>
      ) : (
        <AppShell>
          <Outlet />
        </AppShell>
      )}
    </>
  )
}
