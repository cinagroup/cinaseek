// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type GadgetMetadata,
  type Overseer,
  type WorkspaceReopenMetric,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return {
    openGadget: () => overseer,
    recordWorkspaceReopen: vi.fn<
      (metric: WorkspaceReopenMetric) => Promise<void>
    >(async () => {}),
  } as unknown as RpcStub<AuthenticatedApi>
}

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as GadgetMetadata

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - CinaSeek')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('CinaSeek')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })

  it('releases a safe hidden workspace after the grace period and reopens it when visible', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)

    const firstOverseerDispose = vi.fn<() => void>()
    const firstSubscriptionDispose = vi.fn<() => void>()
    const secondOverseerDispose = vi.fn<() => void>()
    const secondSubscriptionDispose = vi.fn<() => void>()
    const makeOverseer = (
      overseerDispose: ReturnType<typeof vi.fn<() => void>>,
      subscriptionDispose: ReturnType<typeof vi.fn<() => void>>,
    ) => disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, subscriptionDispose) as RpcStub<{}>
        }),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const overseers = [
      makeOverseer(firstOverseerDispose, firstSubscriptionDispose),
      makeOverseer(secondOverseerDispose, secondSubscriptionDispose),
    ]
    const openGadget = vi.fn<() => RpcStub<Overseer>>(() => overseers.shift()!)
    const recordWorkspaceReopen = vi.fn<
      (metric: WorkspaceReopenMetric) => Promise<void>
    >(async () => {})
    const authenticatedApi = {
      openGadget,
      recordWorkspaceReopen,
    } as unknown as RpcStub<AuthenticatedApi>
    let canSuspend = false
    let integrity = { draftPresent: true, attachmentPresent: false }

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
        suspendWhenHidden: true,
        canSuspend,
        hiddenSuspendDelayMs: 0,
        getReopenIntegritySnapshot: () => integrity,
      })
      return <p>{state.suspended ? 'suspended' : state.metadata?.title}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(openGadget).toHaveBeenCalledOnce()

    visibility = 'hidden'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(firstOverseerDispose).not.toHaveBeenCalled()

    canSuspend = true
    await act(async () => root!.render(<Probe />))
    expect(document.visibilityState).toBe('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.runAllTimersAsync()
    })
    expect(container.textContent).toBe('suspended')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(firstOverseerDispose).toHaveBeenCalledOnce()

    integrity = { draftPresent: false, attachmentPresent: false }
    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(openGadget).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Quarterly planning')
    expect(recordWorkspaceReopen).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      outcome: 'ok',
      draftState: 'lost',
      attachmentState: 'not_present',
    }))

    act(() => root!.unmount())
    root = undefined
    expect(secondSubscriptionDispose).toHaveBeenCalledOnce()
    expect(secondOverseerDispose).toHaveBeenCalledOnce()
  })

  it('releases a safe visible workspace after an idle lease and reopens it on activity', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')

    const firstOverseerDispose = vi.fn<() => void>()
    const firstSubscriptionDispose = vi.fn<() => void>()
    const secondOverseerDispose = vi.fn<() => void>()
    const secondSubscriptionDispose = vi.fn<() => void>()
    const makeOverseer = (
      overseerDispose: ReturnType<typeof vi.fn<() => void>>,
      subscriptionDispose: ReturnType<typeof vi.fn<() => void>>,
    ) => disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, subscriptionDispose) as RpcStub<{}>
        }),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const overseers = [
      makeOverseer(firstOverseerDispose, firstSubscriptionDispose),
      makeOverseer(secondOverseerDispose, secondSubscriptionDispose),
    ]
    const openGadget = vi.fn<() => RpcStub<Overseer>>(() => overseers.shift()!)
    const recordWorkspaceReopen = vi.fn<
      (metric: WorkspaceReopenMetric) => Promise<void>
    >(async () => {})
    const authenticatedApi = {
      openGadget,
      recordWorkspaceReopen,
    } as unknown as RpcStub<AuthenticatedApi>

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
        suspendWhenIdle: true,
        canSuspend: true,
        idleSuspendDelayMs: 1_000,
      })
      return <p>{state.suspended ? 'suspended' : state.metadata?.title}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(container.textContent).toBe('suspended')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(firstOverseerDispose).toHaveBeenCalledOnce()

    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'))
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(openGadget).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Quarterly planning')
    expect(recordWorkspaceReopen).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      outcome: 'ok',
    }))

    act(() => root!.unmount())
    root = undefined
    expect(secondSubscriptionDispose).toHaveBeenCalledOnce()
    expect(secondOverseerDispose).toHaveBeenCalledOnce()
  })
})
