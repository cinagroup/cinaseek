import { createFileRoute } from '@tanstack/react-router'

/** Popup-only route rendered by the root from the Access session probe. */
export const Route = createFileRoute('/auth/complete')({ component: () => null })
