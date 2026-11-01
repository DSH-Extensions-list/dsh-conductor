# Attribution

DSH Conductor is derived from Hasan Aghayev's MIT-licensed DSH Task Orchestrator 1.2.1, upstream commit fdbb5bd. The original copyright and MIT license remain in LICENSE and the original git history is preserved. New Conductor changes are released under the same MIT terms.

The test-local continuation fixture adapts the stream/turn hooks of the MIT-declared @local/max-tokens-continue 1.1.0 English package. It is used only to verify interoperability; no installed user profile, data, credentials or live runtime are bundled. Its attribution and permission notice appear in tests/continuation-runtime.spec.ts.

Background lifecycle approaches were compared with MIT-licensed DSH Swarm Orchestrator, DSH Orch-lite, Task Board and DSH native source. Conductor's background registry and child lane are new implementations; these comparisons are documented in docs/research/alternatives.md.
