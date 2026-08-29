import type { PostProcessorModule, TOptions } from 'i18next'
import brandTerminology from '../../../../brand/terminology.json'
import { normalizeLocale, type SupportedLocale } from './locales'

type ProductTerm = keyof typeof brandTerminology.terms

const term = (name: ProductTerm, locale: SupportedLocale): string =>
  brandTerminology.terms[name][locale]

const replacements: Record<SupportedLocale, ReadonlyArray<readonly [RegExp, string]>> = {
  en: [
    [/\bA Gadget\b/g, `An ${term('gadget', 'en')}`],
    [/\ba Gadget\b/g, `an ${term('gadget', 'en')}`],
    [/\bA gadget\b/g, `An ${term('gadget', 'en').toLowerCase()}`],
    [/\ba gadget\b/g, `an ${term('gadget', 'en').toLowerCase()}`],
    [/\bAn Output\b/g, `A ${term('output', 'en')}`],
    [/\ban Output\b/g, `a ${term('output', 'en')}`],
    [/\bAn output\b/g, `A ${term('output', 'en').toLowerCase()}`],
    [/\ban output\b/g, `a ${term('output', 'en').toLowerCase()}`],
    [/\bGatekeepers\b/g, `${term('gatekeeper', 'en')}s`],
    [/\bGatekeeper\b/g, term('gatekeeper', 'en')],
    [/\bBlueprints\b/g, `${term('blueprint', 'en')}s`],
    [/\bBlueprint\b/g, term('blueprint', 'en')],
    [/\bOutputs\b/g, `${term('output', 'en')}s`],
    [/\bOutput\b/g, term('output', 'en')],
    [/\boutputs\b/g, `${term('output', 'en').toLowerCase()}s`],
    [/\boutput\b/g, term('output', 'en').toLowerCase()],
    [/(?<!\.)\bGadgets\b/g, `${term('gadget', 'en')}s`],
    [/(?<!\.)\bGadget\b/g, term('gadget', 'en')],
    [/(?<!\.)\bgadgets\b/g, `${term('gadget', 'en').toLowerCase()}s`],
    [/(?<!\.)\bgadget\b/g, term('gadget', 'en').toLowerCase()],
  ],
  'zh-CN': [
    [/Gatekeepers?/g, term('gatekeeper', 'zh-CN')],
    [/蓝图/g, term('blueprint', 'zh-CN')],
    [/输出/g, term('output', 'zh-CN')],
  ],
  'zh-TW': [
    [/Gatekeepers?/g, term('gatekeeper', 'zh-TW')],
    [/藍圖/g, term('blueprint', 'zh-TW')],
    [/輸出/g, term('output', 'zh-TW')],
  ],
}

/** Applies CinaSeek's user-facing vocabulary without renaming compatibility identifiers. */
export function applyProductTerminology(value: string, locale: SupportedLocale): string {
  let result = value
  for (const [pattern, replacement] of replacements[locale]) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export const terminologyPostProcessor: PostProcessorModule = {
  name: 'cinaseekTerminology',
  type: 'postProcessor',
  process(value: string, _key: string | string[], options: TOptions, translator: { language?: string }) {
    const locale = normalizeLocale(typeof options.lng === 'string' ? options.lng : translator.language) ?? 'en'
    return applyProductTerminology(value, locale)
  },
}
