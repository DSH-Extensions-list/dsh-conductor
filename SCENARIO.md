# Example workflow

Choose the coordinator, worker and reviewer routes in Settings → Conductor, then save. The bundled preset selects Sol Medium / BharatCode DeepSeek Flash / Sol Medium.

Ask: “Implement the CSV importer, add tests, run them, and update its README.” The lead prepares assigned implementation/testing tasks and a final review, then calls conductor_dispatch. Worker task budgets can be omitted: the saved context and provider-declared output controls supply the full allowance. A run receipt returns before completion; ask another question while work continues.

For a concrete tool call:

```json
{
  "objective": "Implement and verify the CSV importer",
  "executeWrites": true,
  "plan": {
    "summary": "Implementation, tests and independent review",
    "risk": "low",
    "requiresConfirmation": false,
    "tasks": [
      {"id":"implementation","owner":"implementer","title":"Implement importer","role":"backend","prompt":"Implement the importer in importer.py and its unit tests. Run the tests and report exact evidence.","dependsOn":[],"readOnly":false,"writeScopes":["importer.py","test_importer.py"]},
      {"id":"docs","owner":"documenter","title":"Document usage","role":"documentation","prompt":"Read implementation evidence, update README.md with accurate examples and report changed files.","dependsOn":["implementation"],"readOnly":false,"writeScopes":["README.md"]},
      {"id":"review","owner":"reviewer","title":"Review code and evidence","role":"reviewer","prompt":"Independently inspect code, tests and documentation; run relevant checks and return approved or concrete corrections. Do not edit implementation files.","dependsOn":["implementation","docs"],"readOnly":true,"writeScopes":[]}
    ]
  }
}
```

Use conductor_message with runId, taskId and message for an active task. Use conductor_status to obtain exact saved plans when resuming blocked work. A resumed call keeps its objective/assignments intact and supplies resumeContext for unfinished tasks. A rejected review does not turn into success: the lead must handle corrections, then obtain fresh review evidence.
