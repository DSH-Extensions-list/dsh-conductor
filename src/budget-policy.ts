/** Combined request capacity offered to DeepSeek workers by Conductor. */
export const WORKER_CONTEXT_TOKENS = 1_000_000

/** Adapter metadata used without inventing a larger provider capacity. */
export interface WorkerModelBudget {
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
  const capacity = model.contextWindow === undefined ? WORKER_CONTEXT_TOKENS : positiveInteger(model.contextWindow, 'contextWindow')
  const contextCeiling = Math.min(WORKER_CONTEXT_TOKENS, capacity)
  const outputCeiling = model.defaultMaxTokens === undefined ? 32_000 : positiveInteger(model.defaultMaxTokens, 'defaultMaxTokens')
  const contextBudget = positiveInteger(requested.contextBudget ?? contextCeiling, 'contextBudget')
  const outputReserveTokens = positiveInteger(requested.outputReserveTokens ?? outputCeiling, 'outputReserveTokens')
  if (contextBudget > contextCeiling) throw new TypeError(`contextBudget exceeds selected model or worker ceiling ${contextCeiling}`)
  if (outputReserveTokens > outputCeiling) throw new TypeError(`outputReserveTokens exceeds declared output allowance ${outputCeiling}`)
  const safetyReserveTokens = positiveInteger(requested.safetyReserveTokens ?? 1_024, 'safetyReserveTokens')
  if (safetyReserveTokens > 1_024) throw new TypeError('safetyReserveTokens exceeds default safety allowance 1024')
  if (outputReserveTokens + safetyReserveTokens >= contextBudget) throw new TypeError('Output and safety reserves leave no input context')
  return { contextBudget, outputReserveTokens, safetyReserveTokens }
}
