import { OPENAI_MODEL_LIMITS } from './openai-model-limits.js'
/** Combined request capacity offered to DeepSeek workers by Conductor. */
export const WORKER_CONTEXT_TOKENS = 1_000_000

/** Adapter metadata used without inventing a larger provider capacity. */
export interface WorkerModelBudget {
  provider?: string
  model?: string
  contextWindow?: number
  defaultMaxTokens?: number
}

/** Optional task-specific reductions of the selected model's normal budget. */
export interface RequestedWorkerBudget {
  contextBudget?: number
  outputReserveTokens?: number
  safetyReserveTokens?: number
}

/** Combined context ceiling and reserves admitted for each worker request. */
export interface WorkerBudget {
  contextBudget: number
  outputReserveTokens: number
  safetyReserveTokens: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

/**
 * Resolve the full declared worker allowance, preserving explicit reductions.
 * Missing provider output metadata uses the deployment's conservative 32K fallback.
 * @param model - Exact selected model's resolved capacity and request default.
 * @param requested - Optional smaller context and output allowances.
 * @returns Combined context budget with output and safety reservations.
 */
export function resolveWorkerBudget(model: WorkerModelBudget, requested: RequestedWorkerBudget = {}): WorkerBudget {
  const id = model.model?.split('/').at(-1)?.toLowerCase() ?? ''
  const official = OPENAI_MODEL_LIMITS[id]
  const policy = contextPolicyForModel(model.provider ?? '', id)
  const reportedContext = model.contextWindow === undefined ? undefined : positiveInteger(model.contextWindow, 'contextWindow')
  if (policy === 'model' && official === undefined && reportedContext === undefined) throw new TypeError('Unknown GPT model needs documented context or provider metadata')
  const documentedContext = official === undefined ? undefined : model.provider === 'codex' && reportedContext === undefined
    ? official.codexDefault ?? official.contextWindow : official.contextWindow
  const contextCeiling = reportedContext === undefined ? documentedContext ?? WORKER_CONTEXT_TOKENS
    : documentedContext === undefined ? reportedContext : Math.min(reportedContext, documentedContext)
  const reportedOutput = model.defaultMaxTokens === undefined ? undefined : positiveInteger(model.defaultMaxTokens, 'defaultMaxTokens')
  const outputCeiling = official === undefined ? reportedOutput ?? 32_000 : Math.min(reportedOutput ?? official.maxOutputTokens, official.maxOutputTokens)
  const requestedContext = requested.contextBudget === undefined ? undefined : positiveInteger(requested.contextBudget, 'contextBudget')
  // DeepSeek and GPT use their actual model window, never a model-authored task allowance.
  const contextBudget = policy === undefined ? requestedContext ?? contextCeiling : contextCeiling
  const outputReserveTokens = positiveInteger(requested.outputReserveTokens ?? outputCeiling, 'outputReserveTokens')
  if (contextBudget > contextCeiling) throw new TypeError(`contextBudget exceeds selected model or worker ceiling ${contextCeiling}`)
  if (outputReserveTokens > outputCeiling) throw new TypeError(`outputReserveTokens exceeds declared output allowance ${outputCeiling}`)
  const safetyReserveTokens = positiveInteger(requested.safetyReserveTokens ?? 1_024, 'safetyReserveTokens')
  if (safetyReserveTokens > 1_024) throw new TypeError('safetyReserveTokens exceeds default safety allowance 1024')
  if (outputReserveTokens + safetyReserveTokens >= contextBudget) throw new TypeError('Output and safety reserves leave no input context')
  return { contextBudget, outputReserveTokens, safetyReserveTokens }
}

/** Model-owned policy; provider mode retains the native DeepSeek window without extra local budget stops. */
export function contextPolicyForModel(provider: string, model: string): 'provider' | 'model' | undefined {
  const id = model.split('/').at(-1)?.toLowerCase() ?? ''
  if (/^deepseek(?:$|[-_.])/.test(id)) return 'provider'
  if (provider === 'codex' || /^gpt-|^o[1-9](?:$|[-.])/.test(id)) return 'model'
  return undefined
}

/** A task window only constrains the route for which it was resolved. Native limits own a changed route. */
export function bindRequestBudget(assigned: { provider: string; model: string } | undefined, actual: { provider: string; model: string }, budget: { contextTokens: number; safetyReserveTokens: number }): typeof budget | undefined {
  return assigned?.provider === actual.provider && assigned.model === actual.model ? budget : undefined
}
