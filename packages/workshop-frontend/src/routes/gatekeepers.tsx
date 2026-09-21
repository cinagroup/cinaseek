import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsPage } from '../pages/connections/ConnectionsPage'

export const Route = createFileRoute('/gatekeepers')({
  component: ConnectionsPage,
})
