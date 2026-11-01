import { describe, expect, it } from 'vitest'
import { assignmentAdvice, MODEL_ASSIGNMENT_GUIDANCE } from '../src/model-assignment.js'
describe('evidence-backed model assignment advice', () => {
  it('distinguishes focused Luna, visual Terra, implementation Muse and the shared BharatCode alternatives', () => {
    expect(assignmentAdvice('codex','gpt-6-luna')).toContain('bounded fixes and targeted tests')
    expect(assignmentAdvice('codex','gpt-6.1-terra')).toContain('visual frontend and browser QA')
    expect(assignmentAdvice('muse','muse-spark-1.3')).toContain('feature implementation and build/test loops')
    expect(assignmentAdvice('bharatcode','deepseek-v4.1-flash')).toContain('bulk implementation and refactoring')
    expect(MODEL_ASSIGNMENT_GUIDANCE).toContain('DeepSeek and Qwen share one BharatCode slot')
    expect(assignmentAdvice('unknown','custom-model')).toEqual([])
  })
})
