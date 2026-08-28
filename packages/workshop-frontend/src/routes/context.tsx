import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'
import { useTranslation } from '../i18n'

// Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
// curated collections of documents (context) and reusable skills. Until then this page shows a
// frosted design mock so the nav entry has a stable, on-language target.
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'
type ContextItemName = 'companyHandbook' | 'brandVoice' | 'apiReference' | 'summarizeMeetings' | 'salesPlaybook' | 'draftCustomerEmail'
type ContextItemDetail = 'documents12' | 'documents5' | 'documents28' | 'documents9' | 'reusableSkill'
type ContextItemUpdated = 'days2' | 'days3' | 'week1' | 'weeks2'

interface ContextItem {
  id: string
  name: ContextItemName
  kind: Kind
  detail: ContextItemDetail
  updated: ContextItemUpdated
}

const TYPE_META: Record<Kind, { Icon: PhosphorIcon }> = {
  collection: { Icon: BookOpen },
  skill: { Icon: Sparkle },
}

const MOCK_ITEMS: ContextItem[] = [
  { id: '1', name: 'companyHandbook', kind: 'collection', detail: 'documents12', updated: 'days2' },
  { id: '2', name: 'brandVoice', kind: 'collection', detail: 'documents5', updated: 'week1' },
  { id: '3', name: 'apiReference', kind: 'collection', detail: 'documents28', updated: 'week1' },
  { id: '4', name: 'summarizeMeetings', kind: 'skill', detail: 'reusableSkill', updated: 'days3' },
  { id: '5', name: 'salesPlaybook', kind: 'collection', detail: 'documents9', updated: 'weeks2' },
  { id: '6', name: 'draftCustomerEmail', kind: 'skill', detail: 'reusableSkill', updated: 'weeks2' },
]

function ContextRow({ item }: { item: ContextItem }) {
  const { t: translate } = useTranslation('contextPage')
  const { Icon } = TYPE_META[item.kind]
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{translate(`items.${item.name}`)}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {translate(`types.${item.kind}`)} · {translate(`details.${item.detail}`)}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {translate(`updated.${item.updated}`)}
      </span>
    </div>
  )
}

function ContextPage() {
  const { t: translate } = useTranslation('contextPage')
  useDocumentTitle(translate('pageTitle'))
  const siteName = useSiteName()
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="px-3 pb-4 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{translate('title')}</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {translate('subtitle')}
        </p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={translate('comingSoon', { siteName })}
        description={translate('preview')}
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {MOCK_ITEMS.map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
