import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { AccessSessionStatus } from './accessSession'

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
    error: null
  })

  // Track current authenticated API stub for cleanup on unmount.
  // State closures go stale in cleanup functions, so we use a ref.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi

  useEffect(() => {
    let cancelled = false
    let pendingAccessApi: RpcStub<AuthenticatedApi> | null = null

    const authenticateWithCfAccess = async () => {
      if (!publicApi) return
      setAuthState(prev => {
        prev.authenticatedApi?.[Symbol.dispose]()
        return { token: null, authenticatedApi: null, isLoading: true, error: null }
      })

      // Promise-pipeline whoami() through authentication. The UI only becomes authenticated after
      // Access verification and the resulting user capability have both succeeded.
      const authenticatedApi = publicApi.authenticateFromCfAccess()
      pendingAccessApi = authenticatedApi
      try {
        await authenticatedApi.whoami()
        if (cancelled) {
          authenticatedApi[Symbol.dispose]()
          return
        }
        setAuthState({
          token: null,
          authenticatedApi,
          isLoading: false,
          error: null
        })
        if (pendingAccessApi === authenticatedApi) pendingAccessApi = null
      } catch (error) {
        authenticatedApi[Symbol.dispose]()
        if (pendingAccessApi === authenticatedApi) pendingAccessApi = null
        if (!cancelled) {
          setAuthState({
            token: null,
            authenticatedApi: null,
            isLoading: false,
            error: error instanceof Error && error.message
              ? error.message
              : 'Cloudflare Access authentication failed.'
          })
        }
      }
    }

    if (CF_ACCESS_MODE) {
      if (accessSessionStatus === 'authenticated' && publicApi) {
        void authenticateWithCfAccess()
      } else {
        setAuthState(prev => {
          prev.authenticatedApi?.[Symbol.dispose]()
          return {
            token: null,
            authenticatedApi: null,
            isLoading: accessSessionStatus === 'checking',
            error: accessSessionStatus === 'error'
              ? 'Could not verify the Cloudflare Access session.'
              : null,
          }
        })
      }
    } else {
      if (!publicApi) {
        setAuthState(prev => ({ ...prev, isLoading: false, error: 'RPC connection unavailable.' }))
        return
      }
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }))
      }
    }
    return () => {
      cancelled = true
      pendingAccessApi?.[Symbol.dispose]()
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi, accessSessionStatus])

  const authenticateWithToken = (token: string) => {
    if (!publicApi) return
    setAuthState(prev => {
      // Dispose the previous authenticated API stub if it exists
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        ...prev,
        authenticatedApi: null, // Clear the disposed stub
        isLoading: true,
        error: null
      }
    })

    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting. Authentication errors will be handled when the stub is actually used.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  const logout = () => {
    if (CF_ACCESS_MODE) {
      window.location.assign('/cdn-cgi/access/logout')
      return
    }

    // Use functional updater to read current state (avoids stale closure).
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        token: null,
        authenticatedApi: null,
        isLoading: false,
        error: null
      }
    })

    localStorage.removeItem('authToken')
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi
  }
}
