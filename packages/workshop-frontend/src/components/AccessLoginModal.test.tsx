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
import AccessLoginModal from './AccessLoginModal'

describe('AccessLoginModal', () => {
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

  it('opens over the current page and starts Access in a popup', async () => {
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
      <AccessLoginModal
        openWindow={openWindow}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => requestAccessLogin('/workspaces'))

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    const continueButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Continue with CinaAuth'))!
    await act(async () => continueButton.click())

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
      <AccessLoginModal
        openWindow={() => popup}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => window.dispatchEvent(new CustomEvent(ACCESS_LOGIN_REQUEST_EVENT, {
      detail: { returnTo: '/' },
    })))
    const continueButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Continue with CinaAuth'))!
    await act(async () => continueButton.click())
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
      <AccessLoginModal
        openWindow={() => popup}
        onAuthenticated={onAuthenticated}
        createRequestId={() => 'test-request-id'}
      />,
    ))
    await act(async () => requestAccessLogin('/'))
    const continueButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Continue with CinaAuth'))!
    await act(async () => continueButton.click())
    await act(async () => window.dispatchEvent(new StorageEvent('storage', {
      key: 'cinaseek:access-login-complete:test-request-id',
      newValue: 'complete',
    })))
    expect(onAuthenticated).toHaveBeenCalledWith('/')
    expect(popup.close).toHaveBeenCalledOnce()
  })
})
