   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->

   - Read `impl-review.json`; it is the source of findings to classify. Do not read or create `impl-triage.json` directly.
   - Produce exactly one disposition for each reviewed finding. Use `apply` with basis `repair-required` to proceed to repair. A must-fix `reject` needs concrete rationale and evidence with basis `already-satisfied` or `finding-invalid`; use `approved-exception` only when supplied canonical input carries approval authority. Informational and deferred findings use `reject` with basis `not-applicable`. Acceptance `notMet` findings must be `apply`.
   - Do not edit Flow state, canonical artifacts, or downstream evidence.
   - Return the typed triage result through the action's structured output. Set `issues` empty, `overview` and `repair` null, and provide `triage.dispositions`. Do not write `effects.json` or run a seal command; the parent validates, materializes, and publishes the canonical triage artifact.
