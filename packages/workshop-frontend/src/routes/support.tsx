import { createFileRoute } from '@tanstack/react-router'
import TrustPage from '../components/trust/TrustPage'

export const Route = createFileRoute('/support')({
  component: () => <TrustPage kind="support" />,
})
