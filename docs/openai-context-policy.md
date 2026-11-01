# OpenAI model context policy

Verified on **2026-11-01** against the exact official model pages below. The machine-readable companion is [openai-model-limits.json](openai-model-limits.json), schema version 1. Its token counts are integers; `null` means that the fetched page did not establish a separate Codex/ChatGPT Work default, rather than an unlimited or zero window.

| Exact configured model ID | API context window | API maximum output | Explicit Codex/Work default on model page |
| --- | ---: | ---: | --- |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | 1,050,000 | 128,000 | 500K tokens |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | 1,050,000 | 128,000 | Not stated |
| [gpt-6.1-terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) | 1,050,000 | 128,000 | Not stated |
| [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | 1,050,000 | 128,000 | Not stated |
| [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | 1,050,000 | 128,000 | Not stated |
| [gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | 1,050,000 | 128,000 | Not stated |
| [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | 1,050,000 | 128,000 | Not stated |
| [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 1,050,000 | 128,000 | Not stated |
| [gpt-daybreak-blue-latest](https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest) | 1,050,000 | 128,000 | Not stated |

Every linked page was actually retrieved and its rendered text explicitly contained `1,050,000 context window` and `128,000 max output tokens`. Daybreak is a moving alias, so this is a dated observation rather than a promise about a later resolution. The Sol 6.1 page additionally states: “GPT-6.1 Sol uses a default context window of 500K tokens in Codex and ChatGPT Work.” The JSON stores this documented 500K as 500,000 tokens. Do not apply that product default to every GPT model without corresponding evidence. The same page says subscription usage has no long-context surcharge; that pricing statement is not a larger account capacity grant.

The sanitized catalogue contained these nine Codex GPT IDs and no o-series IDs. No unknown GPT or o-series model receives a guessed ceiling from this table. In particular, the numeric limits are selected by exact model ID, never by `gpt-*`, `gpt-6*` or model-family prefix. A newly discovered ID needs its own source or adapter metadata.

## Codex subscription adapter behavior

The installed `dsh-plugin-subscriptions@0.9.10` artifact was inspected read-only. The package's repository is [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions); the concrete evidence below is the installed version's `lib/index.js`, not a claim about upstream main.

- Lines 5109–5110 define a generic 400,000-token context fallback and a 128,000-token output default.
- Lines 5490–5491 parse each account catalogue's `context_window` and `max_context_window` into distinct model metadata fields. Model discovery is account-specific; this research did not query account model endpoints or expose account data.
- Lines 5815–5832 resolve exact model information. Reported context comes from `contextWindowFor`; reported `defaultMaxTokens` is configured per-model `maxTokens`, otherwise 128,000.
- Lines 5835–5849 resolve the default as discovered `context_window`, then configured per-model `contextWindow`, then the generic 400,000 fallback. The allowed maximum is discovered `max_context_window`, otherwise that default. A saved `providers.codex.contextWindows[model]` preference becomes `min(preference ?? default, maximum)`.
- `lib/provider-settings.js:81–94,167–170` validates and reads those positive integer preferences. The package README explicitly says the setting changes local DSH history budgeting/compaction and does not send an API capacity override.
- Pool resolution at `lib/index.js:6525–6556` resolves members separately and uses the smallest context/output metadata among usable members. A model-page API capacity does not override a lower account-pool result.
- `codexRequestBody` at lines 5596–5618 does **not** serialize `GenerateOptions.maxTokens` as `max_output_tokens`. Therefore 128,000 is advertised metadata and a local output reserve; this source inspection does not establish an enforceable output cap on the subscription wire. No generation was made to test backend behavior.

The native `ctx.llm.resolveModelInfo(provider, model)` result exposes the resolved context and output default. `defaultMaxTokens` is a configured request default, not a universal maximum-output-capability field; preserve an intentional lower deployment choice without claiming it proves a smaller backend output maximum. The result does not report whether the context came from discovery, configuration, or the generic fallback. A Conductor consumer cannot safely identify every returned 400,000 value as “only fallback.” An account can genuinely advertise that smaller default or maximum.

## Budget resolution recommendation

Keep three distinct facts: the model's published API capability, the current route/account's advertised effective window, and any explicit user choice. A generic orchestrator ceiling must not shrink an otherwise supported 1,050,000-token GPT API window to 1,000,000. DeepSeek's requested 1,000,000-token capacity is likewise independent of a lower historical orchestration tier.

For a verified exact GPT ID, the published API window/output are upper capability bounds. Honor a lower positively reported route/account context window or output limit. Keep explicit smaller user choices. Do not use the published API maximum to bypass account bounds or raise the subscription route silently. For Sol 6.1, the documented Codex/Work default is useful when the route is genuinely unknown; it does not prove an existing 400,000-token metadata value is stale or permit overriding an account's maximum.

If the provider can expose discovery provenance and account `max_context_window`, distinguish a generic fallback from an actual account limit there. Raising a fallback should be a provider-aware metadata correction with the official source and account maximum retained, not a Conductor heuristic that rewrites every 400,000 value. Unknown model IDs retain available route metadata with explicit uncertainty; they must not inherit this GPT table's 1,050,000/128,000 values.

Context is combined request capacity. Output and safety reservations consume room that cannot simultaneously hold input/history. Removing a custom ResourceManager estimate gate does not enlarge a provider window, disable native admission or compaction, or establish 1,050,000 input tokens plus another 128,000 output tokens. Provider tokenization and request overhead still apply. Keep actual provider errors and native compaction authoritative.

This task wrote only the documentation and JSON evidence file. It did not change code, package metadata, profiles, preferences, live account/model settings, workers or sessions; no model requests, restart or reload occurred.
