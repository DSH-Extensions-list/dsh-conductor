import { describe, expect, it } from 'vitest'
import { resolveWorkerBudget, WORKER_CONTEXT_TOKENS } from '../src/budget-policy.ts'

describe('worker budget policy', () => {
  it('uses the complete declared million-token context and output allowance', () => {
    expect(WORKER_CONTEXT_TOKENS).toBe(1_000_000)
    expect(resolveWorkerBudget({ contextWindow: 1_000_000, defaultMaxTokens: 32_000 })).toEqual({ contextBudget: 1_000_000, outputReserveTokens: 32_000, safetyReserveTokens: 1_024 })
    expect(resolveWorkerBudget({ contextWindow: 1_000_000, defaultMaxTokens: 256_000 }).outputReserveTokens).toBe(256_000)
  })
  it('caps context to known smaller model capacity and preserves its declared output', () => {
    expect(resolveWorkerBudget({ contextWindow: 262_144, defaultMaxTokens: 16_384 })).toEqual({ contextBudget: 262_144, outputReserveTokens: 16_384, safetyReserveTokens: 1_024 })
    expect(resolveWorkerBudget({ contextWindow: 2_000_000, defaultMaxTokens: 32_000 }).contextBudget).toBe(2_000_000)
  })
  it('uses explicit conservative fallbacks only for absent metadata', () => {
    expect(resolveWorkerBudget({})).toEqual({ contextBudget: 1_000_000, outputReserveTokens: 32_000, safetyReserveTokens: 1_024 })
  })
  it('allows smaller explicit positive budgets without exceeding declared limits', () => {
    expect(resolveWorkerBudget({ contextWindow: 1_000_000, defaultMaxTokens: 32_000 }, { contextBudget: 50_000, outputReserveTokens: 8_000 })).toEqual({ contextBudget: 50_000, outputReserveTokens: 8_000, safetyReserveTokens: 1_024 })
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid metadata or requested limits %s', invalid => {
    expect(() => resolveWorkerBudget({ contextWindow: invalid })).toThrow()
    expect(() => resolveWorkerBudget({ defaultMaxTokens: invalid })).toThrow()
    expect(() => resolveWorkerBudget({}, { contextBudget: invalid })).toThrow()
    expect(() => resolveWorkerBudget({}, { outputReserveTokens: invalid })).toThrow()
    expect(() => resolveWorkerBudget({}, { safetyReserveTokens: invalid })).toThrow()
  })
  it('rejects requested capacity above the policy or selected model', () => {
    expect(() => resolveWorkerBudget({}, { contextBudget: 1_000_001 })).toThrow(/contextBudget/)
    expect(() => resolveWorkerBudget({ contextWindow: 100_000 }, { contextBudget: 100_001 })).toThrow(/contextBudget/)
    expect(() => resolveWorkerBudget({ defaultMaxTokens: 32_000 }, { outputReserveTokens: 32_001 })).toThrow(/outputReserveTokens/)
  })
  it('preserves an explicit smaller safety reserve', () => {
    expect(resolveWorkerBudget({}, { contextBudget: 8_192, outputReserveTokens: 7_500, safetyReserveTokens: 500 })).toEqual({ contextBudget: 8_192, outputReserveTokens: 7_500, safetyReserveTokens: 500 })
    expect(() => resolveWorkerBudget({}, { safetyReserveTokens: 1_025 })).toThrow(/safetyReserveTokens/)
    expect(() => resolveWorkerBudget({}, { contextBudget: 8_000, outputReserveTokens: 7_500, safetyReserveTokens: 500 })).toThrow(/reserves/)
  })
  it('requires positive input room after output and safety reserves', () => {
    expect(() => resolveWorkerBudget({ contextWindow: 33_024, defaultMaxTokens: 32_000 })).toThrow(/reserves/)
    expect(resolveWorkerBudget({ contextWindow: 33_025, defaultMaxTokens: 32_000 }).contextBudget).toBe(33_025)
  })
})
