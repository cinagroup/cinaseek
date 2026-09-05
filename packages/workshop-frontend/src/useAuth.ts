import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { logoutAccessSession, type AccessSessionStatus } from './accessSession'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export { CF_ACCESS_MODE }

export function useAuth(
  publicApi: RpcStub<PublicApi> | null,
  accessSessionStatus: AccessSessionStatus = publicApi ? 'authenticated' : 'checking',
) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null,
  })

  // State closures go stale in cleanup functions, so retain only the current capability here.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi
  const logoutPending = useRef(false)

  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled && info.type === 'user') setReportedUserId(info.id)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authState.authenticatedApi])

  useEffect(() => {
    let cancelled = false
    let pendingAccessApi: RpcStub<AuthenticatedApi> | null = null

    if (CF_ACCESS_MODE) {
      if (accessSessionStatus !== 'authenticated' || !publicApi) {
        setAuthState((previous) => {
          previous.authenticatedApi?.[Symbol.dispose]()
          return {
            token: null,
            authenticatedApi: null,
            isLoading: accessSessionStatus === 'checking',
            error: accessSessionStatus === 'error'
              ? 'Could not verify the Cloudflare Access session.'
              : null,
          }
        })
      } else {
        setAuthState((previous) => {
          previous.authenticatedApi?.[Symbol.dispose]()
          return { token: null, authenticatedApi: null, isLoading: true, error: null }
        })

        // Pipeline whoami through Access authentication, but expose the capability only after the
        // server has verified the Access JWT and confirmed the account is allowed to sign in.
        const authenticatedApi = publicApi.authenticateFromCfAccess()
        pendingAccessApi = authenticatedApi
        authenticatedApi.whoami().then(() => {
          if (cancelled) {
            authenticatedApi[Symbol.dispose]()
            return
          }
          pendingAccessApi = null
          setAuthState({ token: null, authenticatedApi, isLoading: false, error: null })
        }).catch((error: unknown) => {
          authenticatedApi[Symbol.dispose]()
          pendingAccessApi = null
          if (!cancelled) {
            setAuthState({
              token: null,
              authenticatedApi: null,
              isLoading: false,
              error: error instanceof Error && error.message
                ? error.message
                : 'Cloudflare Access authentication failed.',
            })
          }
        })
      }
    } else if (!publicApi) {
      setAuthState((previous) => ({
        ...previous,
        isLoading: false,
        error: 'RPC connection unavailable.',
      }))
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        const authenticatedApi = publicApi.authenticate(storedToken)
        setAuthState({ token: storedToken, authenticatedApi, isLoading: false, error: null })
      } else {
        setAuthState((previous) => ({ ...previous, isLoading: false }))
      }
    }

    return () => {
      cancelled = true
      pendingAccessApi?.[Symbol.dispose]()
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi, accessSessionStatus])

  const authenticateWithToken = (token: string) => {
    if (!publicApi) return
    setAuthState((previous) => {
      previous.authenticatedApi?.[Symbol.dispose]()
      return { ...previous, authenticatedApi: null, isLoading: true, error: null }
    })
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({ token, authenticatedApi, isLoading: false, error: null })
  }

  const logout = () => {
    if (CF_ACCESS_MODE) {
      if (logoutPending.current) return
      logoutPending.current = true
      void logoutAccessSession().then(() => {
        setReportedUserId(undefined)
        // A full navigation also tears down the old RPC capabilities. Do not clear React auth
        // early: protected routes would otherwise start a fresh Access login during logout.
        window.location.replace('/')
      }).catch(() => {
        setAuthState(previous => ({
          ...previous,
          error: 'Could not sign out. Please retry and try signing out again.',
        }))
      }).finally(() => { logoutPending.current = false })
      return
    }
    setReportedUserId(undefined)
    setAuthState((previous) => {
      previous.authenticatedApi?.[Symbol.dispose]()
      return { token: null, authenticatedApi: null, isLoading: false, error: null }
    })
    localStorage.removeItem('authToken')
  }

  return {
    ...authState,
    login: authenticateWithToken,
    logout,
    isAuthenticated: !!authState.authenticatedApi,
  }
}
