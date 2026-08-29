import { createFileRoute } from '@tanstack/react-router'
import TrustPage from '../components/trust/TrustPage'

export const Route = createFileRoute('/legal/privacy')({
  component: () => <TrustPage kind="privacy" />,
})
