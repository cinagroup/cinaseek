import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'
import { useTranslation } from '../i18n'

/**
 * Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
 * curated collections of documents (context) and reusable skills. Until then this page shows a
 * frosted design mock so the nav entry has a stable, on-language target.
 */
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'

interface ContextItem {
  id: string
  name: string
  kind: Kind
  detail: string
  updated: string
}

const TYPE_ICON: Record<Kind, PhosphorIcon> = { collection: BookOpen, skill: Sparkle }

function ContextRow({ item }: { item: ContextItem }) {
  const { t } = useTranslation('contextPage')
  const Icon = TYPE_ICON[item.kind]
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{item.name}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {t(`types.${item.kind}`)} · {item.detail}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {item.updated}
      </span>
    </div>
  )
}

function ContextPage() {
  const { t } = useTranslation('contextPage')
  useDocumentTitle(t('pageTitle'))
  const siteName = useSiteName()
  const items: ContextItem[] = [
    { id: '1', name: t('items.companyHandbook'), kind: 'collection', detail: t('details.documents12'), updated: t('updated.days2') },
    { id: '2', name: t('items.brandVoice'), kind: 'collection', detail: t('details.documents5'), updated: t('updated.week1') },
    { id: '3', name: t('items.apiReference'), kind: 'collection', detail: t('details.documents28'), updated: t('updated.week1') },
    { id: '4', name: t('items.summarizeMeetings'), kind: 'skill', detail: t('details.reusableSkill'), updated: t('updated.days3') },
    { id: '5', name: t('items.salesPlaybook'), kind: 'collection', detail: t('details.documents9'), updated: t('updated.weeks2') },
    { id: '6', name: t('items.draftCustomerEmail'), kind: 'skill', detail: t('details.reusableSkill'), updated: t('updated.weeks2') },
  ]
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="px-3 pb-4 pt-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{t('title')}</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {t('subtitle')}
        </p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={t('comingSoon', { siteName })}
        description={t('preview')}
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
