import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RPC_HEARTBEAT_INTERVAL_MS,
  startRpcHeartbeat,
} from './connectionHeartbeat'

describe('startRpcHeartbeat', () => {
  afterEach(() => vi.useRealTimers())

  it('probes once per heartbeat interval', async () => {
    vi.useFakeTimers()
    const probe = vi.fn<() => void>()
    startRpcHeartbeat(probe)

    await vi.advanceTimersByTimeAsync(RPC_HEARTBEAT_INTERVAL_MS - 1)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('stops probing after cleanup', async () => {
    vi.useFakeTimers()
    const probe = vi.fn<() => void>()
    const stop = startRpcHeartbeat(probe, 100)

    await vi.advanceTimersByTimeAsync(100)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(probe).toHaveBeenCalledOnce()
  })
})
