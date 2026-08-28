import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, CloudCheck, Warning } from '@phosphor-icons/react'
import CloudflareLogo from '../auth/CloudflareLogo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'
import { useTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'

// Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
// Renders nothing unless the Cloudflare limits flow is enabled server-side.
export default function UsageSettings() {
  const { t } = useTranslation('settings')
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const { add: addToast } = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Account-selection state (only used when the user has multiple Cloudflare accounts).
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) {
      setLoading(false)
      return
    }
    refresh()
    // Re-check when the tab regains focus (e.g. after connecting / topping up elsewhere).
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  // When the server says the user must pick an account, load the list of accounts to choose from.
  useEffect(() => {
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [usage, accounts, authenticatedApi])

  // Hidden entirely when the feature is off, or while the unlimited (self-hosted) default applies.
  if (!limitsEnabled || (usage && usage.unlimited)) return null

  const connect = async () => {
    setBusy(true)
    try {
      // Connecting (or signing in with) Cloudflare is handled by the Cloudflare gatekeeper. Open its
      // OAuth popup; the connected-accounts subscription + focus refresh pick up the result.
      const { url } = await authenticatedApi.connectAccount('cloudflare')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      addToast({ title: t('billing.connectFailed'), variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    setSelecting(accountId)
    try {
      await authenticatedApi.selectCloudflareAccount(accountId)
      addToast({ title: t('billing.accountSelected'), variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      console.error('Failed to select Cloudflare account:', err)
      addToast({ title: t('billing.accountSelectionFailed'), variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        {t('billing.section')}
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p className="text-sm text-kumo-subtle">{t('billing.loading')}</p>
      ) : (
        <div className="space-y-6">
          {/* Free daily allowance */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">{t('billing.allowance')}</p>
            <p className="text-sm text-kumo-default">
              {t('billing.remaining', {
                count: usage.dailyLimit,
                remaining: formatNumber(usage.remaining),
                limit: formatNumber(usage.dailyLimit),
              })}
            </p>
            {usage.resetAt && (
              <p className="text-xs text-kumo-subtle mt-1">
                {t('billing.resetBefore')}<ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />{t('billing.resetAfter')}
              </p>
            )}
          </div>

          {/* Cloudflare connection / credits */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">{t('billing.cloudflareAccount')}</p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>{t('billing.notConnected')}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {t('billing.connectDescription')}
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {t('billing.connect')}
                  </Button>
                </div>
              </div>
            ) : usage.needsAccountSelection ? (
              // Connected, but multiple accounts — force the user to choose which one to bill.
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>{t('billing.chooseAccount')}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {t('billing.chooseAccountDescription')}
                </p>
                {accounts === null ? (
                  <p className="text-sm text-kumo-subtle">{t('billing.loadingAccounts')}</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">
                    {t('billing.noAccounts')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <Button
                        key={a.accountId}
                        variant="secondary"
                        size="sm"
                        className="justify-start"
                        onClick={() => selectAccount(a.accountId)}
                        loading={selecting === a.accountId}
                        disabled={selecting !== null}
                      >
                        {a.accountName}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <CloudCheck size={18} weight="bold" className="text-kumo-success" />
                  <span>
                    {usage.accountName
                      ? t('billing.connectedAccount', { account: usage.accountName })
                      : t('billing.connected')}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  {t('billing.balance')}{' '}
                  {usage.balance !== null ? (
                    <strong>{formatNumber(usage.balance, { style: 'currency', currency: 'USD' })}</strong>
                  ) : (
                    <span className="text-kumo-subtle">{t('billing.unknown')}</span>
                  )}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {t('billing.addCredits')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle border-t border-kumo-line pt-3">
            {t('billing.learnMore')}{' '}
            <a
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t('billing.unifiedBilling')}
            </a>
            .
          </p>
        </div>
      )}
      </div>
    </section>
  )
}
