   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->

   - Read the spec to understand requirements.
   - Keep implementation aligned with the impl review blocking policy. The only blocking impl review failure modes are:
     - `missing_acceptance_requirement`
     - `spec_behavior_contradiction`
     - `security_or_data_integrity_bug`
   - Regression failures, test false positives, scope creep, project-rule violations, naming proposals, refactor proposals, DRY proposals, comment proposals, and docs proposals are not impl review blocking findings. Non-blocking improvements are optional and must name a touched file, observable issue, and replacement action when reported.
   - **Test-only spec detection (autoApprove mode):** If the spec's Goal, Scope, and Requirements indicate that only tests are being added (no production code changes), and `autoApprove: true`:
     1. Set `completionStatus: "skipped"` in the sealed source-worker effect payload.
     2. **Do NOT skip `test-execute`, `test-result-review`, or the flow-level `impl-gate`.** They run regardless because the spec's tests still need execution, artifact review, and regression gate validation.
     3. The dispatcher promotes `test-execute` next.
     4. Display: "auto: test-only spec detected — implement skipped; test-execute will run"
     - If unsure whether the spec is test-only, proceed with normal implementation (err on the side of caution).
   - **Context gathering (supplement-first):** Build understanding in tiers — stop as soon as sufficient. Do NOT re-read material already in context.
     1. The spec (just read above) and test files from the plan phase are the primary inputs. Proceed if they are sufficient.
     2. If target files are not yet in context: `sennel flow get context --search "<spec goal>" --raw` using the spec's Goal section as the query.
     3. If project structure is still unclear after step 2: `sennel flow get context --raw` for a broad overview; then `sennel flow get context <path> --raw` for specific files.
     4. If guardrail articles have NOT been loaded in this session: `sennel flow get guardrail integration` for flow-level implementation work, or `sennel flow get guardrail task-impl` for per-task work. The alias `impl` resolves to `task-impl` for compatibility. If output is non-empty, follow these principles. Skip if already present in context.
   - Before writing code, form a concise implementation approach for each requirement and verify the existing modules and patterns it will reuse. This worker invocation cannot obtain a user reply.
   - If a genuine user decision is required, do not edit source or Flow state; report the blocker. Otherwise proceed directly once the approved Spec and planned tests are present.
   - Aim to make tests pass.
   - Do not call `sennel flow set files`, `set issue-log`, or `set step`. After edits, return the structured source-worker response required by the action schema. The parent captures the Attempt manifest after this worker exits, verifies every observed path, derives mutation IDs and canonical requirement mappings, materializes the sealed handoff, and commits the file-map with completion.
   - **Do NOT run tests in this step.** Test execution is centralized in the `test-execute` step that runs after `implement` completes. Implement code so it is self-consistent; the dispatcher will invoke `test-execute` next.
   - **Prepare/docs scan hard stop:** if preparation or later execution reports that `.sennel/output/analysis.json` cannot be created, read, or validated, stop through the normal flow error path. Do not mask it with manual `flow set step`.
   - **v2 test artifact contract:** `test-execute` produces `test-execute-result.json` version `"2"` and raw output. Started project regression failures still create a normal artifact and advance to `test-result-review`; prerequisite failures before the command starts are hard stops and must be fixed before rerunning.
   - **Placeholder artifact permission:** do not write hand-made placeholder test artifacts to satisfy the flow. If real execution is unavailable, use the `placeholder-permission.json` contract documented in the flow skill; without explicit user permission, flow-level `impl-gate` rejects placeholder artifacts with `ARTIFACT_PLACEHOLDER`.
   - **File-map for impl-gate:** the parent maps every observed change to every canonical requirement in this implementation scope and preserves earlier mappings. Review and integration gate evaluate requirement fulfillment using that mapping and the source evidence.
   - **MUST: If implementation reveals a pre-existing bug outside the current spec's scope**, add a typed issue entry to the structured source-worker response before adjusting the spec or applying a workaround; the parent records it canonically.
   - **On complete**:
     - Run guardrail lint check: `sennel flow run lint`. If violations are found, fix them before proceeding. If lint passes with no guardrail articles defined, this is normal — proceed.
     - return the structured source-worker effect; do not write a handoff or directly complete the Flow step.

   - Return the exact structured output required by the action schema (including `triage:null` and `repair:null`). The parent owns `effects.json` and sealing.
