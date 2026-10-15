## Flow Stop Guidance

**MUST: When a Flow response stops unfinished work and returns control to the user, render its common stop guidance.** Use the envelope's top-level `guidance` together with its sole `data.directive`; the guidance refers to that exact directive and carries no authority to execute an action.

Present the guidance in this order:

1. `explanation` — what happened, retaining the stable error code and typed cause when available.
2. `currentState` — the confirmed completion, persistence, stop, attempt, budget, and timing facts supplied by the CLI. Preserve `unconfirmed` as unconfirmed; do not fill in missing facts.
3. `nextAction` — the selected instruction and its preconditions, as provided by the CLI.

Use `data.directive.kind` and the existing skill procedure to determine what may run; `guidance.nextAction.kind` is a presentation category, never routing authority. Render guidance first, then follow the selected directive:

- `execute_step`, `execute_command`, `execute_continuation`, and `repair_evidence` retain their existing authorization and continuation rules. Continue an authorized action without adding a confirmation. Use its exact command and opaque binding as returned. For an approval prompt, use the existing `requires_approval` / `autoApprove` rules.
- `await_task_review_filter` is an agent-host action. Complete the selected filtering operation during the same turn using its exact command and binding, then continue the existing dispatch procedure without waiting for user confirmation.
- `await_user_decision`, and `blocked` when it carries a prompt, present only the materially different choices carried by that prompt, using Choice Format, and wait for the user's selection.
- `await_draft_question` uses the existing explicit-answer procedure: present the question appropriately, wait for the user's answer, and record only that answer through its existing guarded CLI action.
- `single_user_action` presents the directive's one instruction and preconditions, then stops for that action. It grants no CLI authority; never construct a command from its `actionId` or turn the action into choices.
- A `blocked` directive without a prompt presents its selected external-work instruction and preconditions, then stops. Do not invent a CLI command or recovery route.

If the selected action requests diagnostics or maintenance and grants no recovery authority, give the stable code and diagnostic reference needed to report the issue. Do not guess a retry, recovery path, command, binding, or owner-specific operation.

Never infer recovery from an error code, prose, a prior command, or a skill rule. Do not duplicate the directive's decision in the renderer or rebuild commands/bindings. Do not add a user confirmation when the CLI selected automatic continuation, or add a choice when it selected one concrete action. Ordinary successful, completed, aborted, idle, read-only, and help responses do not gain a new action request.
