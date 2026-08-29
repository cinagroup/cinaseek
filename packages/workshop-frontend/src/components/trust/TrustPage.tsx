import { Link } from '@tanstack/react-router'
import { ArrowSquareOut, CheckCircle, GithubLogo, Hexagon, ShieldCheck } from '@phosphor-icons/react'
import SiteLogo from '../SiteLogo'
import { useTranslation } from '../../i18n'
import { useDocumentTitle } from '../../useDocumentTitle'

export type TrustPageKind = 'privacy' | 'terms' | 'security' | 'support'

const SECTIONS = {
  privacy: [
    { title: 'privacy.sections.scope.title', body: 'privacy.sections.scope.body' },
    { title: 'privacy.sections.data.title', body: 'privacy.sections.data.body' },
    { title: 'privacy.sections.use.title', body: 'privacy.sections.use.body' },
    { title: 'privacy.sections.control.title', body: 'privacy.sections.control.body' },
  ],
  terms: [
    { title: 'terms.sections.account.title', body: 'terms.sections.account.body' },
    { title: 'terms.sections.use.title', body: 'terms.sections.use.body' },
    { title: 'terms.sections.content.title', body: 'terms.sections.content.body' },
    { title: 'terms.sections.availability.title', body: 'terms.sections.availability.body' },
  ],
  security: [
    { title: 'security.sections.model.title', body: 'security.sections.model.body' },
    { title: 'security.sections.identity.title', body: 'security.sections.identity.body' },
    { title: 'security.sections.connections.title', body: 'security.sections.connections.body' },
    { title: 'security.sections.reporting.title', body: 'security.sections.reporting.body' },
  ],
  support: [
    { title: 'support.sections.help.title', body: 'support.sections.help.body' },
    { title: 'support.sections.issues.title', body: 'support.sections.issues.body' },
    { title: 'support.sections.account.title', body: 'support.sections.account.body' },
    { title: 'support.sections.response.title', body: 'support.sections.response.body' },
  ],
} as const

const PRODUCT_LINKS = [
  { to: '/legal/privacy' as const, label: 'privacy.shortTitle' as const },
  { to: '/legal/terms' as const, label: 'terms.shortTitle' as const },
  { to: '/security' as const, label: 'security.shortTitle' as const },
  { to: '/support' as const, label: 'support.shortTitle' as const },
] as const

/** Public, deployment-neutral trust and service-information page for the CinaSeek product. */
export default function TrustPage({ kind }: { kind: TrustPageKind }) {
  const { t } = useTranslation('trust')
  useDocumentTitle(t(`${kind}.title`))

  return (
    <div className="min-h-full bg-kumo-base text-kumo-default">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="mb-10 flex items-center gap-3">
          <SiteLogo size={40} className="shrink-0" srcOverride="/logo.png">
            <Hexagon size={40} weight="bold" className="text-kumo-brand" />
          </SiteLogo>
          <div>
            <p className="font-semibold tracking-tight">CinaSeek</p>
            <p className="text-xs text-kumo-subtle">{t('byCinaGroup')}</p>
          </div>
        </div>

        <div className="mb-10">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-kumo-brand/10 text-kumo-brand">
            {kind === 'security' ? <ShieldCheck size={24} weight="duotone" /> : <CheckCircle size={24} weight="duotone" />}
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-kumo-strong sm:text-4xl">
            {t(`${kind}.title`)}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-kumo-subtle">
            {t(`${kind}.intro`)}
          </p>
          <p className="mt-3 text-xs text-kumo-inactive">{t('updated')}</p>
        </div>

        <div className="space-y-8">
          {SECTIONS[kind].map((section) => (
            <section key={section.title} className="border-t border-kumo-line pt-6">
              <h2 className="text-base font-semibold text-kumo-strong">
                {t(section.title)}
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-kumo-subtle">
                {t(section.body)}
              </p>
            </section>
          ))}
        </div>

        {kind === 'security' && (
          <a
            href="https://github.com/cinagroup/cinaseek/security/advisories/new"
            target="_blank"
            rel="noreferrer"
            className="mt-8 inline-flex items-center gap-2 rounded-lg bg-kumo-brand px-4 py-2.5 text-sm font-medium text-kumo-inverse hover:bg-kumo-brand-hover"
          >
            <ShieldCheck size={17} />
            {t('security.report')}
            <ArrowSquareOut size={14} />
          </a>
        )}

        {kind === 'support' && (
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="https://github.com/cinagroup/cinaseek/issues"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-kumo-brand px-4 py-2.5 text-sm font-medium text-kumo-inverse hover:bg-kumo-brand-hover"
            >
              <GithubLogo size={17} />
              {t('support.openIssue')}
              <ArrowSquareOut size={14} />
            </a>
          </div>
        )}

        <nav aria-label={t('navigation')} className="mt-14 flex flex-wrap gap-x-5 gap-y-2 border-t border-kumo-line pt-6">
          {PRODUCT_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className="text-xs text-kumo-subtle hover:text-kumo-brand">
              {t(link.label)}
            </Link>
          ))}
          <span className="text-xs text-kumo-inactive">© {new Date().getFullYear()} CinaGroup</span>
        </nav>
      </div>
    </div>
  )
}
