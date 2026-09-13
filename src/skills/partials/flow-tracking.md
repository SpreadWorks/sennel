**MUST: For an ordinary worker-owned step, run `sennel flow set step <id> <val>` upon completion to record Flow progress.**

Worker-artifact-handoff-managed exceptions:

- When `next-action.context.workerArtifactHandoff.required` is true, the worker MUST NOT run `flow set step` or write canonical Flow artifacts.
- The worker writes every declared payload to its exact handoff `payloadPath` and runs the exact `sealCommand` once.
- The parent dispatcher validates and publishes the sealed payload, records its revision and receipt, and completes the step. This applies to the managed draft, draft triage/repair/refine, spec, spec triage/repair, and spec-test authoring steps.

Post-hook-managed exceptions:

| Step | Command | Auto-advance condition |
|---|---|---|
| `test-gate` | `sennel flow run requirement-test-gate` | the assigned named test matches its approved preimplementation expectation; Gate alone promotes the candidate |
| `test-execute` | `sennel flow run test-execute` | valid v2 artifact is written |
| `test-result-review` | `sennel flow run test-result-review` | review verdict is `pass` |
| `retro` | `sennel flow run retro` | command succeeds |
| `final-regression` | `sennel flow run final-regression` | final project regression passes |
| `finalize-*` leaves | `sennel flow run finalize-commit`, `finalize-merge`, `finalize-sync`, `finalize-cleanup` | each command succeeds for its own leaf |

Do not advance these manually. Manual completion must not mask Requirement test Gate failures, prerequisite failures, invalid v2 test artifacts, deferred full regression, or failed final-regression evidence.
