<!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->

Classify the immutable findings in the supplied `task-review.json`, using the canonical Task context, mapped requirements, source, and `task-review-binding.json`.

- Return exactly one decision for each original finding key. Preserve the finding identity and meaning. Do not change requirements, constraints, or review findings.
- A must-fix finding is `apply` with basis `repair-required` unless concrete evidence justifies `reject`. Use `already-satisfied` when current canonical source proves the behavior, `finding-invalid` when canonical requirements or source disprove the finding, and explain the evidence in the rationale. Use `approved-exception` only when supplied canonical input carries approval authority; a triage rationale cannot grant an exception.
- Informational and deferred findings are `reject` with basis `not-applicable` and a reason for non-application. This preserves their classification and does not claim the original observation was false.
- Do not edit any source, canonical artifact, or Flow state. Return only structured output: empty `files` and `issues`, null `overview`, `repair`, and `noChangeReason`, and the complete `triage.dispositions`.
- The parent validates the source observation and immutable bindings before publishing this Attempt. It selects the subsequent repair or skip transition.
