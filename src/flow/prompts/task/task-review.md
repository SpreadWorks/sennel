Use this guidance for the per-task code review step. It is scoped to the current task's canonical source surface.

- Read the context provided by `flow get next-action`: `task_spec`, mapped requirements, and the selected current source files. Do not use a repository-wide diff or a task-local test log.
- Step status is automatically managed by `sennel flow run review` hooks (pre sets in_progress, post sets done).
- Run `sennel flow run review` to perform AI-powered code review scoped to this task's surface.
- The task-scoped review uses the same typed disposition contract as flow-level impl review: every finding has a stable lowercase `findingKey`, `must-fix`, `informational`, or `deferred`, a non-empty rationale, and a stable fingerprint recorded by the implementation.
- The disposition is governed by requirement and guardrail evidence, not a fixed category allowlist. Maintainability, naming, refactor, DRY, project-rule, comment, or docs findings are `must-fix` when tied to a mandatory requirement or blocking guardrail; otherwise they are `informational`.
- Review is detection only. It must not edit source files, tests, specs, canonical artifacts, or review evidence. Any observed source edit stops the Task Review Attempt without publishing its result.
- Informational findings are recorded but do not require repair. `must-fix` findings are preserved in the canonical Task Review result for the later task-triage and task-repair steps.
- Reuse the previous `findingKey` for the same problem even when wording changes; use a distinct key for a different problem tied to the same requirement or guardrail.
- Findings should name a touched file when file-specific and provide a replacement action that names the affected function, branch, assertion, prompt sentence, or artifact field.
- If a proposal concerns an intentional guardrail exception, record the applicable guardrail evidence in the finding rationale. Do not record or remediate an exception during review; task-triage decides whether an existing acknowledged exception applies.
- **If `impl-review.json.verdict` is `REJECTED`**:
  1. Read `impl-review.json` and `review.md`.
  2. Report each finding exactly as observed. Do not correct source or explain how a prior correction was insufficient; task-triage decides disposition and task-repair owns source changes and repair evidence.
  3. **Do NOT re-run tests here.** Spec-local execution belongs to the spec-level `test-execute` step and full project regression belongs to `final-regression` (TASK_DEFINITION does not run tests).
- **If verdict is `PASS` or `ADVISORY`**: Display "レビューの結果、修正の必要はありませんでした。"
- **Review limit:** The task-scope limit counts canonical Review semantic results, not CLI invocations. Transport and tooling handling does not consume that semantic result budget.
- **Recovery:** Use `review` for review recovery and `gate` for gate recovery: `sennel flow set retry reset <gate|review> <phase> --reason <text> --yes`. The reason is required and audited, one re-evaluation is granted, and unchanged evidence is rejected.
- On a rejected result, the next-action CLI advances to `task-triage`; on `PASS` or `ADVISORY`, it advances to `task-gate`.
- Use the resolved numeric maxAttempts from the next-action envelope as this stage's semantic review limit.
