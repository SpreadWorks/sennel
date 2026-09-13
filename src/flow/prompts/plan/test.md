   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   - Work only on the Requirement selected by `context.requirementTest`.
   - Treat its Requirement id, approved Spec revision, expectation, bundle revision, and source Attempt as immutable capabilities. Stop if any value is absent or stale.
   - Produce the complete candidate test payload for that Requirement under the exact handoff `spec-tests` path. The parent stages it as an immutable candidate; this worker never edits active `tests.source`.
   - Every candidate file must use the canonical `// spec: R-N` (or supported comment equivalent) header. The assigned Requirement must have exactly one named `R-N:` test across the candidate. Secondary Requirement headers may be preserved but do not satisfy this work item.
   - The test must exercise only a Spec-fixed or existing public surface. Do not invent paths, exports, constants, methods, or artifact shapes.
   - Make the named test express `preimplementation_test_expectation`: `fail` means the current implementation must fail the assertion; `pass` means the current implementation must already pass it.
   - Do not run tests and do not write review, Gate, plan, active test-source, or acceptance artifacts. The fixed `test-review`, `test-repair`, and `test-gate` checkpoints own those steps.
   - Run the exact handoff `sealCommand` once after the candidate payload is complete.
