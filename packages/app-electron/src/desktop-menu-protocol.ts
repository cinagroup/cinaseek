/** Menu identifiers that the trusted CinaSeek renderer may request. */
export const DESKTOP_MENU_IDS = ['file', 'edit', 'view', 'help'] as const

/** Identifier for one of the desktop application's native menus. */
export type DesktopMenuId = (typeof DESKTOP_MENU_IDS)[number]

/** Renderer-relative rectangle used to anchor a native menu below its trigger. */
export interface DesktopMenuAnchor {
  x: number
  y: number
  width: number
  height: number
}

/** A validated request to open one of the desktop application's native menus. */
export interface DesktopMenuRequest {
  menuId: DesktopMenuId
  anchor: DesktopMenuAnchor
}

function boundDesktopMenuCoordinate(item: number): number {
  return Math.max(0, Math.min(100_000, Math.round(item)))
}

/** Returns a bounded native-menu request, or null for malformed renderer input. */
export function parseDesktopMenuRequest(value: unknown): DesktopMenuRequest | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { menuId?: unknown; anchor?: unknown }
  if (!DESKTOP_MENU_IDS.includes(candidate.menuId as DesktopMenuId)) return null
  if (!candidate.anchor || typeof candidate.anchor !== 'object') return null

  const anchor = candidate.anchor as Record<keyof DesktopMenuAnchor, unknown>
  const values = [anchor.x, anchor.y, anchor.width, anchor.height]
  if (!values.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  if ((anchor.width as number) < 0 || (anchor.height as number) < 0) return null

  return {
    menuId: candidate.menuId as DesktopMenuId,
    anchor: {
      x: boundDesktopMenuCoordinate(anchor.x as number),
      y: boundDesktopMenuCoordinate(anchor.y as number),
      width: boundDesktopMenuCoordinate(anchor.width as number),
      height: boundDesktopMenuCoordinate(anchor.height as number),
    },
  }
}
