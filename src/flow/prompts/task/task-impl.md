<!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->

Use this guidance for the per-task implementation step.

- Read the provided task specification, its mapped requirements, and overview. Implement only this task's scope, reusing established project patterns.
- Do not run tests in this step. Spec-local execution is centralized in `test-execute` and project regression in `final-regression`.
- Do not call `sennel flow set files`, `set issue-log`, `set step`, or `run update-overview`; workers have no canonical Flow write authority.
- Make source edits only. If a test is wrong or an out-of-scope bug is found, record a typed issue effect instead of changing Flow state.
- After source edits, return the completion status, issues, and required overview additions through the action's structured output. Set `triage` and `repair` to null. Include every overview category; empty collections are valid. If no source file changed, record a specific non-empty `noChangeReason` instead of inventing a mutation. The parent captures and validates the mutation manifest after this worker exits and maps its changes to all of this Task's canonical requirements.
- Do not write `effects.json` or run a seal command. The parent independently validates the source diff, materializes and seals the effect, records canonical effects under the materialized task identity, and completes the step.
