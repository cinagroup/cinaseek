// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCESS_LOGIN_COMPLETE_MESSAGE,
  ACCESS_LOGIN_REQUEST_EVENT,
  requestAccessLogin,
} from '../accessSession'
import AccessLoginController from './AccessLoginModal'

describe('AccessLoginController', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('opens Access in a popup immediately without rendering an intermediate dialog', async () => {
    const popup = {
      closed: false,
      close: vi.fn<() => void>(),
      focus: vi.fn<() => void>(),
    } as unknown as Window
    const openWindow = vi.fn<(url: string, target: string, features: string) => Window | null>(
      () => popup,
    )
    const onAuthenticated = vi.fn<(returnTo: string) => void>()

    await act(async () => root.render(
      <AccessLoginController
        openWindow={openWindow}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => requestAccessLogin('/workspaces'))

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(openWindow).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Fauth%2Fcomplete%3Frequest%3Dtest-request-id',
      'cinaseek-access-sign-in',
      expect.stringContaining('popup=yes'),
    )
    expect(popup.focus).toHaveBeenCalledOnce()

    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: popup,
      data: { type: ACCESS_LOGIN_COMPLETE_MESSAGE, requestId: 'test-request-id' },
    })))
    expect(onAuthenticated).toHaveBeenCalledWith('/workspaces')
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('ignores completion messages from any other window', async () => {
    const popup = {
      closed: false,
      close: vi.fn<() => void>(),
      focus: vi.fn<() => void>(),
    } as unknown as Window
    const onAuthenticated = vi.fn<(returnTo: string) => void>()
    await act(async () => root.render(
      <AccessLoginController
        openWindow={() => popup}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => window.dispatchEvent(new CustomEvent(ACCESS_LOGIN_REQUEST_EVENT, {
      detail: { returnTo: '/' },
    })))
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: window,
      data: { type: ACCESS_LOGIN_COMPLETE_MESSAGE, requestId: 'test-request-id' },
    })))
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it('accepts a nonce-scoped same-origin storage signal when OAuth severs the opener', async () => {
    const popup = {
      closed: false,
      close: vi.fn<() => void>(),
      focus: vi.fn<() => void>(),
    } as unknown as Window
    const onAuthenticated = vi.fn<(returnTo: string) => void>()
    await act(async () => root.render(
      <AccessLoginController
        openWindow={() => popup}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => requestAccessLogin('/'))
    await act(async () => window.dispatchEvent(new StorageEvent('storage', {
      key: 'cinaseek:access-login-complete:test-request-id',
      newValue: 'complete',
    })))
    expect(onAuthenticated).toHaveBeenCalledWith('/')
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('falls back to full-page authentication when the browser blocks the popup', async () => {
    const onFullPageAuthentication = vi.fn<(returnTo: string) => void>()
    await act(async () => root.render(
      <AccessLoginController
        openWindow={() => null}
        onFullPageAuthentication={onFullPageAuthentication}
        createRequestId={() => 'test-request-id'}
      />,
    ))

    await act(async () => requestAccessLogin('/profile?tab=usage'))

    expect(onFullPageAuthentication).toHaveBeenCalledWith('/profile?tab=usage')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('uses same-window authentication inside the mobile shell', async () => {
    const openWindow = vi.fn<(url: string, target: string, features: string) => Window | null>()
    const onFullPageAuthentication = vi.fn<(returnTo: string) => void>()
    await act(async () => root.render(
      <AccessLoginController
        openWindow={openWindow}
        onFullPageAuthentication={onFullPageAuthentication}
        preferFullPageAuthentication
      />,
    ))

    await act(async () => requestAccessLogin('/workspaces'))

    expect(openWindow).not.toHaveBeenCalled()
    expect(onFullPageAuthentication).toHaveBeenCalledWith('/workspaces')
  })
})
