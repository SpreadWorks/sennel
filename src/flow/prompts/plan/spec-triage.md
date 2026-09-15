   - Read the immutable `spec.json` snapshot and the one canonical `review.json` only from `inputs[].document`.
   - Write one delta, and only one delta, to the exact handoff `payloadPath`. Never edit canonical files.
   - The parent CLI merges the delta into the same `revisions/<n>/review.json` used by `spec-review` and `spec-repair`.
   - A delta has `version: 2`, `stage: "spec-triage"`, the exact immutable `identity`, and `findings[]`. Each finding update names one stable `findingId`, a disposition (`apply`, `invalid`, `already_resolved`, or `downgraded_to_non_blocking`), evidence, and optional explicit target permissions.
   - Classify only findings supplied in the immutable canonical review. Do not require a finding to be classified, do not invent findings, and do not remove unhandled findings.
   - For an `apply` disposition, permissions are explicit `{ target, operationKinds }` capabilities. They authorize only the stated target/kinds; they do not require coverage and do not authorize any other target. A local finding in a string field grants only `edit-text-field`; it is distinct from whole-field `replace-field` and `replace-entity-field` authority. Grant a whole-field replacement kind only when the finding explicitly requires a full-field redesign or replacement.
   - Invalid, stale, or unavailable input is a reason to stop without sealing. A valid empty delta is a semantic no-op and the Flow continues.
   - Malformed JSON, an actual missing or unreadable handoff, and a `review.delta.json` payload-format/schema failure are retryable once with a fresh worker invocation. Identity/revision binding, authority, lineage, and atomic-publication failures are terminal; finding content and target permission semantics are reviewed later by the parent/gate.
   - **On complete**: run the exact handoff `sealCommand` once.
   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
