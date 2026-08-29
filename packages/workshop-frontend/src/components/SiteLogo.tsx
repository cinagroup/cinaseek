import { useEffect, useState, type ReactNode } from 'react'
import { useServerConfig } from '../ServerConfigContext'

export const DEFAULT_SITE_LOGO_URL = '/logo.png'

export default function SiteLogo({
  size,
  className,
  srcOverride,
  children,
}: {
  size: number
  className?: string
  srcOverride?: string | null
  children: ReactNode
}) {
  const serverConfig = useServerConfig()
  const configuredUrl = serverConfig?.siteLogo?.url
  const src = srcOverride === undefined
    ? configuredUrl ?? DEFAULT_SITE_LOGO_URL
    : srcOverride ?? DEFAULT_SITE_LOGO_URL
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src, serverConfig])

  if (!src || failed) return children
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`rounded-[3px] object-contain ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  )
}
