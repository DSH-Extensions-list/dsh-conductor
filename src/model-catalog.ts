/** Discover native routes and the supported official Muse CLI transport. @module */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { TaskModel } from './types.js'
import { MUSE_MODELS } from './muse-cli.js'

export const OFFICIAL_MUSE_MODELS = MUSE_MODELS
export const MUSE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export interface MuseAvailability { available: boolean; reason?: string; version?: string }
export interface CatalogModel {
  provider: string
  model: string
  name: string
  transport: 'native' | 'muse-cli'
  reasoningEfforts: string[]
  contextWindow?: number
  defaultOutputTokens?: number
  note?: string
}
export interface ModelCatalog { models: CatalogModel[]; errors: Array<{ provider: string; message: string }> }

/** Read only provider-advertised metadata. CLI presence is not proof of subscription entitlement. */
export async function discoverModels(llm: LlmRuntime, muse: MuseAvailability, provider?: string, model?: string): Promise<ModelCatalog> {
  const result: ModelCatalog = { models: [], errors: [] }
  for (const route of llm.listProviders()) {
    if (route.id === 'muse' || provider !== undefined && provider !== route.id) continue
    try {
      const models = await llm.listModels(route.id)
      for (const advertised of models) {
        if (model !== undefined && model !== advertised.id) continue
        try {
          const info = await llm.resolveModelInfo(route.id, advertised.id)
          result.models.push({ provider: route.id, model: info.id, name: info.name, transport: 'native',
            reasoningEfforts: info.reasoning?.efforts.map(effort => effort.id) ?? [],
            ...(info.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
            ...(info.defaultMaxTokens === undefined ? {} : { defaultOutputTokens: info.defaultMaxTokens }),
            note: 'Registered provider catalog; inference access has not been probed.' })
        } catch {
          result.errors.push({ provider: route.id, message: `Model ${advertised.id} details are unavailable; other advertised models remain listed.` })
        }
      }
    } catch { result.errors.push({ provider: route.id, message: 'Provider model catalog is unavailable. Check its account and provider settings.' }) }
  }
  if (provider === undefined || provider === 'muse') {
    if (!muse.available) result.errors.push({ provider: 'muse', message: muse.reason ?? 'Official Muse CLI is unavailable or not signed in.' })
    else for (const id of OFFICIAL_MUSE_MODELS) if (model === undefined || model === id) result.models.push({ provider: 'muse', model: id, name: id,
      transport: 'muse-cli', reasoningEfforts: [...MUSE_EFFORTS], note: `${muse.version ?? 'Official Muse CLI'}; account login present, model entitlement is checked by the CLI when starting.` })
  }
  if (provider !== undefined && provider !== 'muse' && !llm.listProviders().some(p => p.id === provider)) result.errors.push({ provider, message: 'Provider is not registered.' })
  return result
}

/** Validate explicit task choices before saving a graph or starting any child. */
export async function resolveTaskRoute(llm: LlmRuntime, selection: TaskModel, muse: MuseAvailability, signal: AbortSignal): Promise<{ transport: 'native'; info: Awaited<ReturnType<LlmRuntime['resolveModelInfo']>> } | { transport: 'muse-cli' }> {
  signal.throwIfAborted()
  if (selection.provider === 'muse') {
    if (!muse.available) throw new Error(muse.reason ?? 'Official Muse CLI is unavailable or not signed in')
    if (!(OFFICIAL_MUSE_MODELS as readonly string[]).includes(selection.model)) throw new Error('Choose an available official Muse model from conductor_models')
    if (selection.reasoningEffort !== undefined && !(MUSE_EFFORTS as readonly string[]).includes(selection.reasoningEffort)) throw new Error('Unsupported Muse reasoning effort; inspect conductor_models')
    return { transport: 'muse-cli' }
  }
  if (!llm.listProviders().some(provider => provider.id === selection.provider)) throw new Error(`Provider ${selection.provider} is not registered`)
  const models = await llm.listModels(selection.provider)
  if (!models.some(model => model.id === selection.model)) throw new Error(`Model ${selection.provider}/${selection.model} is not advertised as available; inspect conductor_models`)
  const info = await llm.resolveModelInfo(selection.provider, selection.model, signal)
  if (selection.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new Error(`Unsupported reasoning effort for ${selection.provider}/${selection.model}`)
  return { transport: 'native', info }
}
