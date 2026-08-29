import { createContext, useContext } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import type { AccessSessionStatus } from './accessSession'

/**
 * Context to provide the RPC stub and connection state throughout the app.
 * The stub is wrapped in an object to avoid React's callable-state-setter issue.
 */
export type RpcContextValue = {
  stub: RpcStub<PublicApi> | null
  connectionLost: boolean
  accessSessionStatus: AccessSessionStatus
}

export const RpcContext = createContext<RpcContextValue | null>(null)

export function useRpcContext(): RpcContextValue {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error('useRpcContext must be used within RpcContext.Provider')
  return ctx
}

export function useRpcStub(): RpcStub<PublicApi> {
  const ctx = useRpcContext()
  if (!ctx.stub) throw new Error('RPC is unavailable before authentication')
  return ctx.stub
}

export function useConnectionLost(): boolean {
  const ctx = useContext(RpcContext)
  return ctx?.connectionLost ?? false
}
