import { describe, expect, it } from 'vitest'
import { workersAiModelOptionLabel } from './AddModelModal'

describe('workersAiModelOptionLabel', () => {
  it('shows a model ID only once when Cloudflare also uses it as the name', () => {
    expect(workersAiModelOptionLabel({
      id: '@cf/meta/llama-3.1-8b-instruct-fp8',
      name: '@cf/meta/llama-3.1-8b-instruct-fp8',
    })).toBe('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  it('ignores case and surrounding whitespace when detecting a repeated ID', () => {
    expect(workersAiModelOptionLabel({
      id: '@cf/meta/model',
      name: '  @CF/META/MODEL  ',
    })).toBe('@cf/meta/model')
  })

  it('keeps both a distinct display name and the canonical model ID', () => {
    expect(workersAiModelOptionLabel({
      id: '@cf/meta/llama-3.1-8b-instruct-fp8',
      name: 'Llama 3.1 8B Instruct',
    })).toBe('Llama 3.1 8B Instruct · @cf/meta/llama-3.1-8b-instruct-fp8')
  })
})
