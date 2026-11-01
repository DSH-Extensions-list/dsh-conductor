# Model routing and official Muse workers implementation plan

**Goal:** Sol discovers usable models, selects a provider/model per task, and runs official Muse CLI workers inside Conductor's existing lifecycle and serialized child queue.

**Architecture:** A catalog combines registered native DSH models with the standard official Muse CLI models. Tasks capture a provider/model/reasoning selection. Native tasks retain the existing spawn adapter. Muse tasks use an isolated, cancellable CLI process and output schema, with subscription credentials handled by the official client. Worker admission is shared across transports; final-review dependency gates remain authoritative.

**Constraints:** No subscription-key API adapter, key extraction, attestation bypass, Contributor models, shell command interpolation, or silent model substitution. Preserve task assignments on resume; default role selections still work. Read-only CLI workers disable writes and shell. Cancellation waits for process exit before freeing the lane. Do not reload over active work.

- [x] Add failing task-model parse/routing/checkpoint tests, implement route validation and selection.
- [x] Add failing official CLI process/result/cancellation tests, implement adapter with bounded output, process-tree cleanup, and exact schema result capture.
- [x] Register catalog tool; validate exact available models/reasoning before dispatch and expose unavailable-route diagnostics.
- [x] Integrate native and CLI transports under the same queue and owned cancellation/message/status lifecycle.
- [x] Exercise mixed-model routing, read-only/authorized file writes, review, failure, cancellation, and queue recovery through the real DSH runtime plus live Muse CLI.
- [x] Run repository checks, review changes, package/install when idle, and verify actual model-facing tool schemas and end-to-end results in the installed runtime.

**Review focus:** misleading catalog availability, implicit fallback models, changed resume routes, dead CLI processes retaining permits, and oversized/malformed CLI results. Add tests for each at its owning seam.
