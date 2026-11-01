import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { resolveWorkerBudget, bindRequestBudget } from '../src/budget-policy.ts'
import { ResourceManager } from '../src/resource-manager.ts'

const next = async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
const context = { agents: { get: () => undefined } } as never
const request = (model: string, characters = 600_000) => ({ provider: 'test', model, maxTokens: 32_000, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(characters) }] }] }) as never

describe('per-model context policy', () => {
  it('does not apply an assigned route window to a different actual request route', () => {
    const old = { provider: 'bharatcode', model: 'deepseek-v4.1-flash' }
    const budget = { contextTokens: 114_688, safetyReserveTokens: 1_024 }
    expect(bindRequestBudget(old, { provider: 'openai', model: 'gpt-6.1-sol' }, budget)).toBeUndefined()
    expect(bindRequestBudget({ provider: 'openai', model: 'gpt-6-sol' }, { provider: 'openai', model: 'gpt-6.1-sol' }, budget)).toBeUndefined()
    expect(bindRequestBudget(old, old, budget)).toEqual(budget)
  })

  it('uses the full DeepSeek million-token window even when a task asks for the old small cap', () => {
    const result = resolveWorkerBudget({ provider: 'bharatcode', model: 'deepseek-v4.1-flash', contextWindow: 1_000_000, defaultMaxTokens: 32_000 }, { contextBudget: 114_688 })
    expect(result.contextBudget).toBe(1_000_000)
  })
  it('uses documented GPT capacity without the DeepSeek blanket million-token clamp', () => {
    expect(resolveWorkerBudget({ provider: 'openai', model: 'gpt-6.1-sol' })).toMatchObject({ contextBudget: 1_050_000, outputReserveTokens: 128_000 })
    expect(resolveWorkerBudget({ provider: 'codex', model: 'gpt-6.1-sol' }).contextBudget).toBe(500_000)
    expect(resolveWorkerBudget({ provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 400_000 }).contextBudget).toBe(400_000)
    expect(resolveWorkerBudget({ provider: 'openai', model: 'gpt-6.1-sol', contextWindow: 2_000_000, defaultMaxTokens: 256_000 })).toMatchObject({ contextBudget: 1_050_000, outputReserveTokens: 128_000 })
  })
  it('never invents an unknown GPT window when provider metadata is missing', () => {
    expect(() => resolveWorkerBudget({ model: 'gpt-unverified-future' })).toThrow(/metadata|documented/i)
  })
  it('lets DeepSeek cross obsolete task/shared caps and still consumes the worker lane', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 98_304, totalContextTokens: 98_304,
      requestBudget: () => ({ contextTokens: 114_688, safetyReserveTokens: 1_024 }), contextPolicy: () => 'provider' })
    const chunks = []
    for await (const chunk of manager.stream(context, request('deepseek-v4.1-flash'), next)) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(manager.activeGenerations).toBe(0)
  })
  it('uses the GPT model cap instead of a stale shared cap and emits native overflow recovery errors at the real cap', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 98_304, totalContextTokens: 98_304,
      requestBudget: () => ({ contextTokens: 1_050_000, safetyReserveTokens: 1_024 }), contextPolicy: () => 'model' })
    const chunks=[]
    for await (const chunk of manager.stream(context, request('gpt-6.1-sol'), next)) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(() => manager.stream(context, request('gpt-6.1-sol', 4_300_000), next)).toThrowError(expect.objectContaining({ code: CONTEXT_WINDOW_EXCEEDED_CODE }))
  })
})
