Inspect the immutable findings from the current canonical Task Review and complete the typed host filter boundary.

- This is a host action, not a worker step or user approval. Do not invoke an agent worker and do not edit source.
- Exclude a finding only by its stable `findingId`, with a specific non-empty reason grounded in canonical requirements, guardrails, or source.
- Classification does not select the repair set: every must-fix, informational, and deferred finding remains selected unless explicitly excluded.
- Confirm the complete exclusion set once through the exact CLI command in the next-action directive. Use `[]` when no finding is excluded.
- The CLI validates the current Attempt, Review artifact, source fingerprint, catalog publication, finding identities, and reasons before atomically publishing the canonical filter audit and advancing.
