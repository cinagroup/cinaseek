import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from '../i18n'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  const { t } = useTranslation('blueprints')
  useDocumentTitle(t('explorePageTitle'))

  return <BlueprintsPage />
}
