import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'

function durationParts(ms: number): { hours: number; minutes: number; seconds: number } {
  if (ms <= 0) return { hours: 0, minutes: 0, seconds: 0 }
  const totalSeconds = Math.floor(ms / 1000)
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  }
}

// Live-ticking countdown to a reset time (ISO timestamp). Updates once per second. Calls
// `onElapsed` once when the countdown reaches zero (e.g. to refresh usage). Renders nothing if no
// valid `resetAt` is provided.
export default function ResetCountdown({
  resetAt,
  onElapsed,
}: {
  resetAt?: string
  onElapsed?: () => void
}) {
  const { t } = useTranslation('settings')
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest onElapsed in a ref so the "elapsed" effect can fire it without depending on a
  // (possibly unstable) callback identity, which would otherwise re-run the effect every render.
  const onElapsedRef = useRef(onElapsed)
  onElapsedRef.current = onElapsed

  const target = resetAt ? new Date(resetAt).getTime() : NaN
  const valid = Number.isFinite(target)

  useEffect(() => {
    if (!valid) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [valid, resetAt])

  const remaining = valid ? target - now : 0
  const elapsed = valid && remaining <= 0

  useEffect(() => {
    if (elapsed) onElapsedRef.current?.()
  }, [elapsed])

  if (!valid) return null

  const duration = durationParts(remaining)
  const parts: string[] = []
  if (duration.hours > 0) parts.push(t('billing.duration.hours', { count: duration.hours }))
  if (duration.hours > 0 || duration.minutes > 0) {
    parts.push(t('billing.duration.minutes', { count: duration.minutes }))
  }
  parts.push(t('billing.duration.seconds', { count: duration.seconds }))

  return <span className="tabular-nums font-medium">{parts.join(' ')}</span>
}
