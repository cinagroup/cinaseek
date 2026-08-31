// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
} from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { useConnectedAccounts } from './useConnectedAccounts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VENDOR = {
  displayName: 'Google',
  tagline: 'Google services',
  color: '#4285f4',
} as VendorDescription

function accountDescription(name: string): AccountDescription {
  return {
    displayName: name,
    uniqueName: name,
    avatar: { url: 'data:image/svg+xml,test' },
  }
}

function subscription(dispose: () => void) {
  return Object.assign(Promise.resolve({ [Symbol.dispose]: dispose }), {
    [Symbol.dispose]: dispose,
  })
}

function AccountList({
  authenticatedApi,
  renderToken,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  renderToken: number
}) {
  const { accounts, loaded } = useConnectedAccounts(authenticatedApi)
  return (
    <div data-render-token={renderToken} data-loaded={loaded}>
      {accounts.map((account) => (
        <span key={account.id}>{account.accountDescription.displayName}</span>
      ))}
    </div>
  )
}

describe('useConnectedAccounts', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  it('subscribes once and publishes the initial account replay atomically', async () => {
    let subscriber: ConnectedAccountsSubscriber | undefined
    const dispose = vi.fn<() => void>()
    const subscribeConnectedAccounts = vi.fn<
      (next: ConnectedAccountsSubscriber) => ReturnType<typeof subscription>
    >((next) => {
      subscriber = next
      return subscription(dispose)
    })
    const authenticatedApi = {
      subscribeConnectedAccounts,
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<AccountList authenticatedApi={authenticatedApi} renderToken={0} />)
      await Promise.resolve()
    })

    expect(subscribeConnectedAccounts).toHaveBeenCalledOnce()
    expect(subscriber).toBeDefined()

    await act(async () => {
      subscriber!.add(1, accountDescription('first@example.com'), VENDOR, [], true, 'google')
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('first@example.com')

    await act(async () => {
      subscriber!.add(2, accountDescription('second@example.com'), VENDOR, [], true, 'google')
      subscriber!.ready()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('first@example.com')
    expect(container.textContent).toContain('second@example.com')

    await act(async () => {
      root!.render(<AccountList authenticatedApi={authenticatedApi} renderToken={1} />)
      await Promise.resolve()
    })
    expect(subscribeConnectedAccounts).toHaveBeenCalledOnce()

    act(() => root!.unmount())
    root = undefined
    expect(dispose).toHaveBeenCalledOnce()
  })
})
