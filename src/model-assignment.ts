/** Task-fit guidance from current official docs and attributed practitioner reports. @module */
const advice: Record<string, string[]> = {
  'codex/gpt-6.1-sol': ['coordination, planning and integration', 'general implementation and final review'],
  'codex/gpt-6-astra': ['difficult architecture and ambiguous debugging', 'hard reasoning and research synthesis'],
  'codex/gpt-6-luna': ['bounded fixes and targeted tests', 'extraction and routine independent checks'],
  'codex/gpt-6.1-terra': ['visual frontend and browser QA', 'documentation and natural writing'],
  'bharatcode/deepseek-v4.1-flash': ['bulk implementation and refactoring', 'input-heavy code investigation'],
  'bharatcode/qwen-3.8-27b': ['bounded patches, tests and documentation', 'independent second opinion'],
  'muse/muse-spark-1.3': ['feature implementation and build/test loops', 'isolated frontend or browser work'],
}
export function assignmentAdvice(provider: string, model: string): string[] { return [...advice[`${provider}/${model}`] ?? []] }

export const MODEL_ASSIGNMENT_GUIDANCE = 'Choose models by the task and current conductor_models catalog, not by an invented universal ranking. '
  + 'Keep Sol as the coordinator/planner/integrator. Use Luna for bounded fixes and targeted tests; Terra for visual frontend/browser QA and writing; '
  + 'Muse Spark 1.3 for isolated feature implementation and build/test loops; DeepSeek Flash for bulk implementation/refactors and large code investigations; '
  + 'Qwen for bounded patches/tests/docs or an independent second opinion; Astra for difficult architecture, ambiguous debugging or hard reasoning when justified. '
  + 'DeepSeek and Qwen share one BharatCode slot. Other independent models may run alongside that single BharatCode child within the configured concurrent-child limit. Omit dispatch maxWorkers unless you mean to reduce the TOTAL task-graph count including final review; it is not the concurrent-child limit. '
  + 'Declare exact file ownership, use disjoint scopes or separate workspaces for independent work, and sequence dependent or conflicting edits. '
  + 'These are starting recommendations from official positioning and mixed practitioner reports, not measured guarantees in this installation. '
  + 'Use acceptance checks and concrete failure evidence to revise future assignments. Never change an explicit saved task model during resume or silently substitute another model.'
