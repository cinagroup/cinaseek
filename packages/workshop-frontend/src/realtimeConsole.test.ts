import { describe, expect, it } from 'vitest'
import { parseRealtimeConsoleMessage } from './realtimeConsole'

describe('parseRealtimeConsoleMessage', () => {
  it('restores a validated console batch', () => {
    const parsed = parseRealtimeConsoleMessage({
      type: 'console',
      chatId: 7,
      events: [{
        timestamp: '2026-08-31T12:34:56.789Z',
        level: 'warn',
        message: ['example', {count: 2}],
      }],
    })

    expect(parsed).toEqual({
      chatId: 7,
      events: [{
        timestamp: new Date('2026-08-31T12:34:56.789Z'),
        level: 'warn',
        message: ['example', {count: 2}],
      }],
    })
  })

  it('rejects malformed envelopes and events', () => {
    expect(parseRealtimeConsoleMessage({type: 'presence', events: []})).toBeNull()
    expect(parseRealtimeConsoleMessage({type: 'console', chatId: 1.5, events: []})).toBeNull()
    expect(parseRealtimeConsoleMessage({
      type: 'console', chatId: null,
      events: [{timestamp: 'not-a-date', level: 'log', message: []}],
    })).toBeNull()
    expect(parseRealtimeConsoleMessage({
      type: 'console', chatId: null,
      events: [{timestamp: '2026-08-31T12:34:56.789Z', level: 'fatal', message: []}],
    })).toBeNull()
  })
})
