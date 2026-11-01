import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { discoverModels, resolveTaskRoute } from '../src/model-catalog.js'

const luna = { id: 'gpt-6-luna', name: 'Luna', provider: 'codex', reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } }
function fixture() {
  const listed: string[] = []
  const llm = {
    listProviders: () => [{ id: 'codex', name: 'Codex' }, { id: 'muse', name: 'Old unsupported API route' }, { id: 'offline', name: 'Offline' }],
    listModels: async (id: string) => { listed.push(id); if (id === 'offline') throw Error('catalog offline'); if (id === 'muse') throw Error('Must never use subscription API route'); return [luna] },
    resolveModelInfo: async (provider: string, model: string) => { if (provider === 'muse' || model !== luna.id) throw Error('unexpected resolution'); return luna },
  } as unknown as LlmRuntime
  return { llm, listed }
}
describe('Conductor model catalog', () => {
  it('continues after one model detail lookup fails and names output defaults accurately', async () => {
    const llm = {
      listProviders: () => [{ id: 'native', name: 'Native' }],
      listModels: async () => [{ id: 'broken' }, { id: 'healthy' }],
      resolveModelInfo: async (_provider: string, model: string) => {
        if (model === 'broken') throw new Error('detail unavailable')
        return { id: model, name: model, defaultMaxTokens: 8192 }
      },
    } as unknown as LlmRuntime
    const result = await discoverModels(llm, { available: false }, 'native')
    expect(result.models).toEqual([expect.objectContaining({ provider: 'native', model: 'healthy', defaultOutputTokens: 8192 })])
    expect(result.models[0]).not.toHaveProperty('maxOutputTokens')
    expect(result.errors).toContainEqual(expect.objectContaining({ provider: 'native', message: expect.stringContaining('broken') }))
  })

  it('advertises native Luna and official CLI Muse, isolates failed providers, and excludes subscription API transport', async () => {
    const { llm, listed } = fixture()
    const result = await discoverModels(llm, { available: true, version: 'Muse Code 1.4' })
    expect(result.models).toContainEqual(expect.objectContaining({ provider: 'codex', model: 'gpt-6-luna', transport: 'native', reasoningEfforts: ['low'] }))
    expect(result.models).toContainEqual(expect.objectContaining({ provider: 'muse', model: 'muse-spark-1.3', transport: 'muse-cli' }))
    expect(result.models.filter(m => m.provider === 'muse').every(m => m.transport === 'muse-cli')).toBe(true)
    expect(result.errors).toEqual([expect.objectContaining({ provider: 'offline' })])
    expect(listed).not.toContain('muse')
  })
  it('reports missing CLI separately without offering a broken Muse route', async () => {
    const { llm } = fixture(); const result = await discoverModels(llm, { available: false, reason: 'Official Muse CLI is unavailable' }, 'muse')
    expect(result.models).toEqual([]); expect(result.errors).toEqual([expect.objectContaining({ provider: 'muse', message: expect.stringContaining('unavailable') })])
  })
  it('rejects unknown native selections and unsupported efforts before any child is started', async () => {
    const { llm } = fixture()
    await expect(resolveTaskRoute(llm, { provider: 'codex', model: 'invented' }, { available: true }, new AbortController().signal)).rejects.toThrow(/advertised|available/)
    await expect(resolveTaskRoute(llm, { provider: 'codex', model: luna.id, reasoningEffort: 'max' }, { available: true }, new AbortController().signal)).rejects.toThrow(/reasoning/)
    await expect(resolveTaskRoute(llm, { provider: 'codex', model: luna.id, reasoningEffort: 'low' }, { available: true }, new AbortController().signal)).resolves.toMatchObject({ transport: 'native', info: luna })
  })
  it('validates official Muse ids and effort without invoking a DSH Muse API adapter', async () => {
    const { llm, listed } = fixture()
    await expect(resolveTaskRoute(llm, { provider: 'muse', model: 'muse-spark-1.3', reasoningEffort: 'medium' }, { available: true }, new AbortController().signal)).resolves.toEqual({ transport: 'muse-cli' })
    await expect(resolveTaskRoute(llm, { provider: 'muse', model: 'muse-wonder-1.0' }, { available: true }, new AbortController().signal)).rejects.toThrow(/official|available/)
    await expect(resolveTaskRoute(llm, { provider: 'muse', model: 'muse-spark-1.3' }, { available: false }, new AbortController().signal)).rejects.toThrow(/CLI/)
    expect(listed).toEqual([])
  })
})
