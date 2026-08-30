import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from './i18n'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import type { WorkersAiModelInfo } from '@gadgets/workshop-shared/workers-ai-gatekeeper'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible endpoint',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  'openai-compatible': '(optional)',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
}

// Examples used in custom-model placeholders for providers with no suggested model catalog.
const FALLBACK_EXAMPLE_MODELS: Partial<Record<AiModelProvider, { modelId: string, name: string }>> = {
  'openai-compatible': { modelId: 'my-model', name: 'My Custom Model' },
  ollama: { modelId: 'gemma4:31b', name: 'Gemma 4 31B' },
}

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first
    ? { modelId: first[0], name: first[1].name }
    : FALLBACK_EXAMPLE_MODELS[provider] ?? { modelId: 'model-id', name: 'Custom Model' }
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && provider !== 'cloudflare' && !enabledProviders.has(provider)) continue

    if (provider === 'cloudflare') {
      options.push({
        value: encodeSelection(provider),
        label: PROVIDER_LABELS[provider],
        provider,
      })
      continue
    }

    // Workers AI is always user-funded, even when other providers use deployment Gateway mode.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

/** Format a Workers AI model option without repeating an ID used as its display name. */
export function workersAiModelOptionLabel(
  model: Pick<WorkersAiModelInfo, 'id' | 'name'>,
): string {
  const displayName = model.name.trim()
  return displayName && displayName.toLowerCase() !== model.id.toLowerCase()
    ? `${displayName} · ${model.id}`
    : model.id
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const { t } = useTranslation('providers')
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [shareWithUsers, setShareWithUsers] = useState(false)
  const [workersAiConnected, setWorkersAiConnected] = useState(false)
  const [workersAiAccountName, setWorkersAiAccountName] = useState('')
  const [workersAiModels, setWorkersAiModels] = useState<WorkersAiModelInfo[]>([])
  const [workersAiLoading, setWorkersAiLoading] = useState(false)
  const [workersAiLoadFailed, setWorkersAiLoadFailed] = useState(false)

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setApiUrl('')
      setShareWithUsers(false)
      setWorkersAiConnected(false)
      setWorkersAiAccountName('')
      setWorkersAiModels([])
      setWorkersAiLoading(false)
      setWorkersAiLoadFailed(false)
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const loadWorkersAi = useCallback(async () => {
    setWorkersAiLoading(true)
    setWorkersAiLoadFailed(false)
    try {
      const connection = await authenticatedApi.getWorkersAiConnectionInfo()
      setWorkersAiConnected(connection !== null)
      setWorkersAiAccountName(connection?.displayName ?? '')
      if (!connection) {
        setWorkersAiModels([])
        return
      }
      try {
        setWorkersAiModels(await authenticatedApi.listWorkersAiCatalog('text-generation'))
      } catch (error) {
        console.error('Failed to load Workers AI models:', error)
        setWorkersAiModels([])
        setWorkersAiLoadFailed(true)
      }
    } catch (error) {
      console.error('Failed to load Workers AI connection:', error)
      setWorkersAiConnected(false)
      setWorkersAiModels([])
      setWorkersAiLoadFailed(true)
    } finally {
      setWorkersAiLoading(false)
    }
  }, [authenticatedApi])

  useEffect(() => {
    if (!visible || selection?.provider !== 'cloudflare') return
    void loadWorkersAi()
    const refreshAfterAccountWindow = () => { void loadWorkersAi() }
    window.addEventListener('focus', refreshAfterAccountWindow)
    return () => window.removeEventListener('focus', refreshAfterAccountWindow)
  }, [visible, selection?.provider, loadWorkersAi])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setShareWithUsers(false)
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? t('addDialog.errors.selectProvider') : t('addDialog.errors.selectModel')
    }

    if (selection?.type === 'custom' && selection.provider !== 'cloudflare') {
      if (!modelId.trim()) newErrors.modelId = t('addDialog.errors.modelId')
      if (!displayName.trim()) newErrors.displayName = t('addDialog.errors.displayName')
    }

    const isOllama = selection?.provider === 'ollama'
    const isOpenAiCompatible = selection?.provider === 'openai-compatible'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode && !isCloudflare

    if (isCloudflare) {
      if (!workersAiConnected) newErrors.workersAi = t('addDialog.errors.workersAiConnection')
      if (!modelId) newErrors.modelId = t('addDialog.errors.workersAiModel')
    }

    if (showCredentials && selection && !isOllama && !isOpenAiCompatible && !apiToken.trim()) {
      newErrors.apiToken = t('addDialog.errors.apiToken')
    }

    if (((showCredentials && isOllama) || isOpenAiCompatible) && !apiUrl.trim()) {
      newErrors.apiUrl = isOllama
        ? t('addDialog.errors.ollamaUrl')
        : gatewayMode
        ? t('addDialog.errors.gatewayPath')
        : t('addDialog.errors.compatibleUrl')
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode || selection!.provider === 'cloudflare' ? '' : apiToken.trim(),
        ...(selection!.provider === 'cloudflare' && shareWithUsers && {
          shareWithUsers: true,
        }),
        ...((!gatewayMode || selection!.provider === 'openai-compatible') && apiUrl.trim() && {
          apiUrl: apiUrl.trim(),
        }),
      }

      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: t('addDialog.added'), variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: t('addDialog.addFailed'), variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleConnectWorkersAi = async () => {
    try {
      const { url } = await authenticatedApi.connectAccount('workers_ai')
      const popup = window.open(url, 'cinaseek-workers-ai', 'popup,width=560,height=720')
      if (!popup) {
        toasts.add({ title: t('addDialog.workersAiPopupBlocked'), variant: 'error' })
      }
    } catch (error) {
      console.error('Failed to start Workers AI connection:', error)
      toasts.add({ title: t('addDialog.workersAiConnectFailed'), variant: 'error' })
    }
  }

  const handleWorkersAiModelSelect = (value: string) => {
    const model = workersAiModels.find(candidate => candidate.id === value)
    setModelId(value)
    setDisplayName(model?.name ?? value)
    setShareWithUsers(false)
    setErrors(previous => ({ ...previous, modelId: '', workersAi: '' }))
  }

  const options = buildOptions(gatewayMode, enabledProviders).map((option) =>
    option.value.startsWith('other-') && option.provider !== 'cloudflare'
      ? { ...option, label: t('addDialog.otherProvider', { provider: PROVIDER_LABELS[option.provider as AiModelProvider] || option.provider }) }
      : option)
  const isOllama = selection?.provider === 'ollama'
  const isOpenAiCompatible = selection?.provider === 'openai-compatible'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCustomFields = selection?.type === 'custom' && !isCloudflare
  const example = selection ? exampleModel(selection.provider) : null
  const showCredentials = !gatewayMode && !isCloudflare
  const canShare = isCloudflare && modelId in SUGGESTED_MODELS.cloudflare

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {t('addDialog.title')}
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? t('addDialog.selectProvider') : t('addDialog.selectModel')}
            className="w-full text-sm"
            placeholder={gatewayMode ? t('addDialog.chooseProvider') : t('addDialog.chooseModel')}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {isCloudflare && (
            <div className="space-y-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-kumo-default">
                    {workersAiConnected
                      ? t('addDialog.workersAiConnected', { account: workersAiAccountName })
                      : t('addDialog.workersAiConnectionTitle')}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-4 text-kumo-subtle">
                    {workersAiConnected
                      ? t('addDialog.workersAiConnectedDescription')
                      : t('addDialog.workersAiConnectionDescription')}
                  </p>
                </div>
                {workersAiConnected ? (
                  <Button variant="secondary" size="sm" onClick={() => void loadWorkersAi()}
                    loading={workersAiLoading}>
                    {t('addDialog.refreshWorkersAi')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => void handleConnectWorkersAi()}
                    loading={workersAiLoading}>
                    {t('addDialog.connectWorkersAi')}
                  </Button>
                )}
              </div>

              {workersAiConnected && (
                <>
                  <Select
                    label={t('addDialog.workersAiModel')}
                    className="w-full text-sm"
                    placeholder={workersAiLoading
                      ? t('addDialog.loadingWorkersAiModels')
                      : t('addDialog.chooseWorkersAiModel')}
                    value={modelId || undefined}
                    onValueChange={(value) => handleWorkersAiModelSelect(value as string)}
                    error={errors.modelId}
                    renderValue={(value) => workersAiModels.find(model => model.id === value)?.name ?? String(value)}
                  >
                    {workersAiModels.map(model => (
                      <Select.Option key={model.id} value={model.id}>
                        {workersAiModelOptionLabel(model)}
                      </Select.Option>
                    ))}
                  </Select>
                  {!workersAiLoading && workersAiModels.length === 0 && (
                    <p className={`text-xs ${workersAiLoadFailed ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
                      {workersAiLoadFailed
                        ? t('addDialog.workersAiModelsLoadFailed')
                        : t('addDialog.noWorkersAiModels')}
                    </p>
                  )}
                </>
              )}
              {errors.workersAi && (
                <p className="text-xs text-kumo-danger">{errors.workersAi}</p>
              )}
            </div>
          )}

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label={t('addDialog.modelId')}
                placeholder={`e.g., ${example!.modelId}`}
                description={t('addDialog.modelIdDescription', { example: example!.modelId })}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label={t('addDialog.displayName')}
                placeholder={`e.g., ${example!.name}`}
                description={t('addDialog.displayNameDescription')}
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <SensitiveInput
              label={t('addDialog.apiToken')}
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? t('addDialog.apiTokenOllama')
                  : isOpenAiCompatible
                  ? t('addDialog.apiTokenCompatible')
                  : isCloudflare
                  ? t('addDialog.apiTokenCloudflare')
                  : t('addDialog.apiTokenProvider', { provider: PROVIDER_LABELS[selection.provider] })
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {canShare && (
            <div className="flex items-start gap-4 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-kumo-default">
                  {t('addDialog.shareTitle')}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 text-kumo-subtle">
                  {t('addDialog.shareDescription')}
                </p>
              </div>
              <Switch
                checked={shareWithUsers}
                onCheckedChange={setShareWithUsers}
                aria-label={t('addDialog.shareTitle')}
              />
            </div>
          )}

          {/* Direct endpoint URL, or the deployment Gateway's Custom Provider route. */}
          {((showCredentials && isOllama) || isOpenAiCompatible) && (
            <Input
              label={isOpenAiCompatible && gatewayMode ? t('addDialog.gatewayProviderPath') : t('addDialog.apiUrl')}
              placeholder={isOllama
                ? 'http://localhost:11434'
                : gatewayMode
                ? 'custom-my-provider/v1'
                : 'https://api.example.com/v1'}
              description={isOllama
                ? t('addDialog.ollamaUrlDescription')
                : gatewayMode
                ? t('addDialog.gatewayPathDescription')
                : t('addDialog.compatibleUrlDescription')}
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for providers with a standard default endpoint */}
          {showCredentials && selection && !isOllama && !isOpenAiCompatible && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>{t('addDialog.advanced')}</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label={t('addDialog.apiUrl')}
                  placeholder="https://..."
                  description={t('addDialog.overrideUrlDescription')}
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              {t('addDialog.cancel')}
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            {t('addDialog.submit')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
