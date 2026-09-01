import type {
  ConsoleLogEvent,
  RealtimeConsoleMessage,
} from '@gadgets/workshop-shared/api'

/** Parsed realtime console batch with wire timestamps restored to `Date` values. */
export type ParsedRealtimeConsoleMessage = {
  chatId: number | null
  events: ConsoleLogEvent[]
}

/** Validate an untrusted JSON frame from the realtime socket and restore its timestamps. */
export function parseRealtimeConsoleMessage(value: unknown): ParsedRealtimeConsoleMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'console' ||
      (record.chatId !== null && !Number.isInteger(record.chatId)) ||
      !Array.isArray(record.events)) return null

  const events: ConsoleLogEvent[] = []
  for (const candidate of record.events) {
    if (!candidate || typeof candidate !== 'object') return null
    const event = candidate as Record<string, unknown>
    if (typeof event.timestamp !== 'string' ||
        (event.level !== 'debug' && event.level !== 'info' && event.level !== 'log' &&
         event.level !== 'warn' && event.level !== 'error') ||
        !Array.isArray(event.message)) return null
    const timestamp = new Date(event.timestamp)
    if (Number.isNaN(timestamp.valueOf())) return null
    events.push({
      timestamp,
      level: event.level,
      message: event.message,
    })
  }

  const message = value as RealtimeConsoleMessage
  return {chatId: message.chatId, events}
}
