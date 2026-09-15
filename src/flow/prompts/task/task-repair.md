<!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->

Repair every finding selected by the host-owned `task-review-filter.json` and projected as `apply` in immutable `task-triage.json`, retaining the original findings from `task-review.json` and their `task-review-binding.json`.

- Edit only paths admitted by this Task's mutation lineage. Auxiliary files are allowed only inside that same allow-list and when tied to an apply finding.
- Report each finding key with every changed path contributing to its repair. Several findings may share a path, and one finding may need several allowed paths. Every apply finding and every actual change must be covered.
- Use the supplied prior review, triage, and repair history in `task-review-recurrence.json`. For a recurring finding, explain why the prior repair was insufficient and how this repair addresses that failure.
- Always return `repair.recurrenceResolutions` as an array: use `[]` when the supplied recurrence history has no entries; otherwise include exactly one resolution for each supplied recurrence fingerprint.
- Do not modify the spec, Task scope, review, triage, canonical artifacts, HEAD, or index. Do not run tests in this step.
- Return the structured repair report. The parent assigns mutation identities and canonical requirement mappings from observed changes and publishes the immutable repair artifact. Do not write `effects.json` or seal the handoff yourself.
- If a safe source mutation is not possible or the selected findings are already satisfied without a change, return the typed `noChangeReason` outcome with every selected finding key and a specific reason. Make no source mutation in that outcome. The parent records it as canonical unrepaired/no-change evidence and advances without rerunning this worker.
