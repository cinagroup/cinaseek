// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthenticatedApiBoundary, AuthProvider } from './AuthContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("AuthenticatedApiBoundary", () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function mount(node: ReactNode) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(node))
  }

  it("does not render a capability consumer outside AuthProvider", () => {
    let rendered = false
    mount(
      <AuthenticatedApiBoundary>
        {() => {
          rendered = true
          return <span>private workspace</span>;
        }}
      </AuthenticatedApiBoundary>,
    );

    expect(rendered).toBe(false)
    expect(container!.textContent).toBe('')
  })

  it("passes the authenticated capability through while the provider is mounted", () => {
    const authenticatedApi = {
      whoami: () => new Promise(() => {}),
      amIAdmin: () => new Promise(() => {}),
    } as unknown as RpcStub<AuthenticatedApi>
    let received: RpcStub<AuthenticatedApi> | undefined
    mount(
      <AuthProvider authenticatedApi={authenticatedApi} onLogout={() => {}}>
        <AuthenticatedApiBoundary>
          {(api) => {
            received = api
            return <span>private workspace</span>;
          }}
        </AuthenticatedApiBoundary>
      </AuthProvider>,
    );

    expect(received).toBe(authenticatedApi)
    expect(container!.textContent).toBe('private workspace')
  })
})
