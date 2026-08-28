import { createFileRoute } from '@tanstack/react-router'

// The root route owns this popup-only surface so it can render directly from the Access session
// probe without waiting for the full authenticated RPC/onboarding flow.
export const Route = createFileRoute('/auth/complete')({ component: () => null })
