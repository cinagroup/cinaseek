import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useTranslation } from './i18n'

/** Returns localized titles for first-party management apps and preserves third-party titles. */
export function useLocalizedGatekeeperAppTitle(): (app: GatekeeperAppInfo) => string {
  const { t } = useTranslation('shell')
  return (app) => {
    if (app.id === 'context') return t('gatekeeperApps.context')
    if (app.id === 'scheduler') return t('gatekeeperApps.scheduler')
    return app.title
  }
}
