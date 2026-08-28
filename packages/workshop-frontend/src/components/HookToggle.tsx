import { Switch, Tooltip } from '@cloudflare/kumo'
import { useTranslation } from '../i18n'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

// Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat.
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  const { t: translate } = useTranslation('actionControls')
  return (
    <Tooltip content={enabled ? translate('disableHookDescription') : translate('enableHookDescription')} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? translate('disableHook') : translate('enableHook')}
        />
      </span>
    </Tooltip>
  )
}
