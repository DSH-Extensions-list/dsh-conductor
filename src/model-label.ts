import type { TaskModel } from './types.js'

/** Stable plain-text label for native Fleet names and task progress. */
export function formatTaskModel(model: TaskModel): string {
  return `${model.provider}/${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}`
}
