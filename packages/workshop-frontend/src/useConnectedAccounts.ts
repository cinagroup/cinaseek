import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { AccountsSubscriberAdapter } from './accountsSubscriber'
import { logRpcFailure } from './rpcErrors'

/** Everything the Connections page renders for one connected account. */
export interface AccountEntry {
  id: number
  accountDescription: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

/** Subscribes to connected accounts and atomically publishes the initial replay at ready(). */
export function useConnectedAccounts(authenticatedApi: RpcStub<AuthenticatedApi>): {
  accounts: AccountEntry[]
  loaded: boolean
  loadError: boolean
} {
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let initialReplayComplete = false
    const accountMap = new Map<number, AccountEntry>()

    setLoaded(false)
    setLoadError(false)

    const publishAccounts = () => setAccounts(Array.from(accountMap.values()))
    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorId,
          vendorDescription: vendor,
          supportedResources,
          credentialsValid,
        })
        if (initialReplayComplete) publishAccounts()
      },
      remove(id) {
        accountMap.delete(id)
        if (!cancelled && initialReplayComplete) publishAccounts()
      },
      ready() {
        if (cancelled) return
        initialReplayComplete = true
        publishAccounts()
        setLoaded(true)
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
      setLoadError(true)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  return { accounts, loaded, loadError }
}
