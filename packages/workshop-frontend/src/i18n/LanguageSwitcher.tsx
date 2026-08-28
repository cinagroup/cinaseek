import { useTransition } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { Check, Translate } from '@phosphor-icons/react'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../components/menuStyles'
import { getCurrentLocale, setLocale, useTranslation } from './index'
import { LOCALE_OPTIONS, type SupportedLocale } from './locales'

/** Compact language picker used in the persistent application chrome. */
export function LanguageMenu() {
  const { t } = useTranslation('common')
  const [isPending, startTransition] = useTransition()
  const currentLocale = getCurrentLocale()
  const currentName = LOCALE_OPTIONS.find((option) => option.locale === currentLocale)?.nativeName ?? currentLocale
  const label = t('language.current', { language: currentName })

  const selectLocale = (locale: SupportedLocale) => {
    if (locale === currentLocale) return
    startTransition(async () => setLocale(locale))
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button
            type="button"
            disabled={isPending}
            title={label}
            aria-label={t('language.menuLabel')}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated disabled:cursor-wait disabled:opacity-60"
          >
            <Translate size={15} />
          </button>
        )}
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        {LOCALE_OPTIONS.map((option) => (
          <DropdownMenu.Item
            key={option.locale}
            onClick={() => selectLocale(option.locale)}
            className={`${MENU_ITEM} flex items-center justify-between gap-4`}
          >
            <span lang={option.locale}>{option.nativeName}</span>
            {option.locale === currentLocale ? <Check size={14} weight="bold" /> : null}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** Full-width language selector used on the profile settings page. */
export function LanguageSelect() {
  const { t } = useTranslation('common')
  const [isPending, startTransition] = useTransition()
  const currentLocale = getCurrentLocale()

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="interface-language" className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">
        {t('language.label')}
      </label>
      <select
        id="interface-language"
        value={currentLocale}
        disabled={isPending}
        onChange={(event) => {
          const locale = event.target.value as SupportedLocale
          startTransition(async () => setLocale(locale))
        }}
        className="h-9 w-full max-w-xs rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] text-kumo-default outline-none transition-[border-color,box-shadow] focus:border-kumo-ring focus:ring-[3px] focus:ring-kumo-ring/15 disabled:cursor-wait disabled:opacity-60"
      >
        {LOCALE_OPTIONS.map((option) => (
          <option key={option.locale} value={option.locale} lang={option.locale}>
            {option.nativeName}
          </option>
        ))}
      </select>
      <p className="text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
        {t('language.description')}
      </p>
    </div>
  )
}
