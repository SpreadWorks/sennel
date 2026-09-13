   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   - Work only on the current reviewed Requirement candidate and bounded finding batch supplied by the handoff's `requirementTestBinding` and `testReviewRepair` fields.
   - Verify the Requirement id, approved Spec revision, predecessor bundle revision and digest, source review Attempt, allowed test paths, and finding fingerprints before editing.
   - When repair is required, return only the allowed candidate files. Preserve all unaffected coverage and do not edit active `tests.source`.
   - When no repair is required, publish no candidate mutation; the parent records the mandatory no-op checkpoint and proceeds to Gate.
   - Multi-batch intermediate state belongs only to the parent-owned repair progress checkpoint. The worker must not create its own journal or advance bundle revisions per batch.
   - Do not run tests or decide retry, defer, promotion, or the next Requirement. Definition owns those decisions.
   - Run the exact handoff `sealCommand` once after the bounded repair payload is complete.
