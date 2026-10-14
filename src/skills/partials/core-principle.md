**MUST: When a rule in this skill conflicts with a memory entry (e.g. `feedback_*.md` referenced from `MEMORY.md`), the skill rule takes precedence.** Memory entries that contradict skill rules should be considered stale; update or delete them.

**Use the CLI's `requires_approval` field to decide whether user confirmation is required before a step.**
Do not ask the user to confirm routine step execution when `requires_approval: false`.

**autoApprove check (MANDATORY):**
Before presenting any choice to the user, you MUST run `sennel flow get status` and display the `autoApprove` field value. This is not optional — skipping this check is a protocol violation.
- If the current flow `runId` is known, prefer `sennel flow get status <runId>` so the check reads the target flow instead of an unrelated current context.
- `active: true` is not by itself a reason to stop a new flow start. Parallel flows are allowed when the new target is addressed by an explicit preparing `runId` and verified with target-aware status.
- When starting a new flow while another flow is active, record the `runId` returned by `sennel flow set init`; before and after `sennel flow prepare --run-id <runId>`, verify the target with `sennel flow get status <runId> --expect-run-id <runId>` plus every known `--expect-issue` and `--expect-spec` guard.
- After a dispatcher target is selected, target-sensitive dispatcher continuation commands for that flow must use the CLI-generated opaque `--expect-binding <token>` returned by the Flow command. Do not assemble runId, Issue, or spec guards for normal dispatcher continuation.
- If the user explicitly continues an existing flow and the target Issue is known, run `sennel flow get status <runId> --expect-run-id <runId> --expect-issue <n>` when `runId` is known. Without a target `runId`, use bare status for display and do not treat another active flow as authorization to continue it.
- If the user explicitly continues an existing spec target, run `sennel flow get status --expect-spec <spec>` before dispatcher actions.
- If the user explicitly continues an existing runId target for dispatcher continuation, run `sennel flow get status <runId> --expect-run-id <runId>` before dispatcher actions.
- Treat `ACTIVE_FLOW_MISMATCH` as a no-mutation boundary. Do not retry a
  target-sensitive command by editing guard strings; refresh target authority
  through the CLI and continue only when the returned directive or command is
  for the intended Flow.
- Store runId and binding values returned by the CLI as opaque tokens. Never
  shorten, reconstruct, or infer a runId or binding from a branch, path, or
  prose.
- A preparing flow still reports `autoApprove: false` in status; use the `sennel flow set auto on --run-id <runId>` response and `sennel flow prepare --run-id <runId>` inheritance for prelude auto mode.
- Bare `sennel flow get status` remains valid for current-context display and for detecting whether any active flow exists before a runId is known.
- If the next-action envelope has `requires_approval: false`, execute the step without a "run this step?" confirmation. This applies even when `autoApprove: false`.
- If `requires_approval: true` and `autoApprove: false` (or field is missing): present the choice to the user and wait for input.
- If `requires_approval: true` and `autoApprove: true`: treat choice id=1 as selected and proceed immediately. Display progress briefly (e.g. "auto: approval → [1] 承認").
- Continue without waiting when the step does not require approval, or when `autoApprove: true` satisfies a required approval.
- If a step fails (command error, gate FAIL, test failure), apply the retry limits defined in each skill. If the retry limit is reached, STOP and return control to the user.

**autoApprove exceptions (MUST present to user even when `autoApprove: true`):**
The following user-facing choices are explicit exceptions to the auto-select rule because silently picking `[1]` would risk irreversible loss:
- `finalize-cleanup` orphan-commit recovery prompt (`ORPHAN_COMMITS_DETECTED`): always present the cherry-pick / abort / force-continue choice to the user. Do not auto-select. See `flow.run.finalize-cleanup` for details.
- Any choice whose envelope error code begins with `SQUASH_BASELINE_` or `FORCED_ORPHAN_`: surface the recovery guidance verbatim and let the user decide.

<!-- {{data("base.skills.rule", {id: "no-auto-mode-override-skill"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "wait-for-instruction-skill"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "thoroughness"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "no-shortcuts"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "no-scope-splitting"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "commit-split-strategy"})}} -->
<!-- {{/data}} -->

<!-- {{data("base.skills.rule", {id: "no-chain-product-cli"})}} -->
<!-- {{/data}} -->

**Flow runtime log rule (MANDATORY):**
- Never hardcode `/tmp/...` for flow-related logs or temporary files.
- To select the agent execution directory for the current invocation, pass `--agent-work-dir <path>` to `sennel flow run ...`. This setting does not select input, schema, or log storage.
- Selected Flow inputs and schemas use repository-owned `.tmp/flows/<specId>/<runId>`; non-Flow and preparing calls use `.tmp/runtime/<purpose>`. Logs use the independent `.tmp/logs` default.
- Flow commands automatically append stdout/stderr to `.tmp/logs/<flowId>.log`, or `.tmp/logs/no-flow.log` when no flow is active.
- Use `sennel flow get runtime-log` to inspect the latest flow command output after failures.
- Do not wrap flow commands with environment-variable prefixes or shell redirection just to capture logs; keep the command prefix as `sennel flow ...` so approval-prefix rules can match it.
