/** Exact official model limits verified 2026-11-01; evidence in docs/openai-model-limits.json. */
export const OPENAI_MODEL_LIMITS: Readonly<Record<string, { contextWindow: number; maxOutputTokens: number; codexDefault?: number; source: string }>> = {
  "gpt-5.6-luna": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-5.6-luna"
  },
  "gpt-5.6-sol": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol"
  },
  "gpt-5.6-terra": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-5.6-terra"
  },
  "gpt-6-astra": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-6-astra"
  },
  "gpt-6-luna": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-6-luna"
  },
  "gpt-6-sol": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-6-sol"
  },
  "gpt-6.1-sol": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "codexDefault": 500000,
    "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol"
  },
  "gpt-6.1-terra": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-6.1-terra"
  },
  "gpt-daybreak-blue-latest": {
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "source": "https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest"
  }
}
