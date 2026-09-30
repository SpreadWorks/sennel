# File reference and read retry verification (board 6928)

Source base: `c9c1e855a91ccfb74b47230aec3dfe43056e0a30`, plus this task's working-tree
implementation and tests. The original Flow #521 was neither resumed nor changed.
All measurement/scenario work uses separate disposable repositories.

## Consumer ledger

| Consumer | Existing authority and reuse decision |
| --- | --- |
| Draft and Spec Gate (`run-gate.js`, `gate-prompt-plan.js`) | `GuardrailFileInput.create` owns exact UTF-8 bytes and cleanup. Shared `AgentFileReference` supplies the absolute and explicit-project-root relative paths; shared response protocol owns read/format retry and evidence. Gate adapters retain interpretation and publication. |
| `src/docs/commands/forge.js:165` (`materializeForgeInputReference`) | Caller owns digest-addressed `forge-inputs`; `ForgeInputReferencePromptElement` currently emits a root-relative reference while Agent begins in `paths.agentWorkDir`. Candidate for later shared reference adoption; no forge behavior changed here. |
| `src/flow/lib/run-dispatch.js:1241` and `worker-artifact-handoff.js:5200,5538,5562,5577` | Dispatcher passes a handoff request path; handoff checks captured digest and sealed output identity. This separate authority and worker side effects cannot be converted into Gate response retries. |
| `src/skills/sennel.flow-resume/SKILL.md:21` | Canonical-version path is resolved under status/recovery authority. A generic snapshot reference must consume the resolved file, not select canonical artifacts or resume a Flow. No resume behavior changed. |

## Outcome-to-condition mapping

| Observable outcome | Conditions, producer, storage/readback and consumer | Covering evidence |
| --- | --- | --- |
| Read failures recover on fourth provider launch with exact prior history | Same complete file/revision/group; three typed unavailable responses; bypass fresh retries; shared admissions; registered Gate producer; saved phase Gate artifact; new FlowManager reload | Draft artifact scenario; Spec artifact scenario's large-file case. All pre-existing Spec/Acceptance consumption and semantic repair-cycle assertions remain. |
| Four read failures stop without partial semantic publication | Earlier accepted group, later unavailable group; exact Attempt; four admissions; typed exhausted evidence; existing Store/ActivityFailure; reload then Definition next-action and dispatcher refusal | `file-read-exhaustion-scenario.test.js`, separately for Draft and Spec. Semantic node and Attempt consumption are unchanged during response retries; restart launches zero providers. |
| Context limit stops without response retry or earlier findings publication | Typed `context-limit`, not inferred from reason text; ordinary Spec producer and dispatcher; Store/readback | Existing `spec-file-failure-scenario.test.js`, retained with wire-kind migration only. |
| Stale Attempt and transaction failure do not report false durable success | Exact lifecycle binding; ActivityFailure persistence; failure of canonical commit; serialized evidence rehydration | `spec-gate-command-boundary.test.js` persistence scenarios (owned by root implementation). |
| Initial invalid references refuse before evaluation and leave canonical authorities unchanged | Real reference/capture failures for missing file, directory, permission, root escape, symlink, opening identity, initial digest mismatch and disappearance before the first response; existing StepAdmissionRefusal through the registered dispatcher | `gate-file-input-admission.test.js`: eight conditions per phase. Fault-specific messages and injection hits are asserted; canonical state, catalog, ledger, immutable publications and revisions are compared byte-for-byte, then reloaded. |
| Real AI reads exact bytes despite a different initial cwd | Configured production Agent/provider; explicit execution directory inside separate fixture repository; both prompt paths resolve to same digest; full-file parser and admission; meaningful head/tail timeout inconsistency | `file-read-reference-measurement.mjs` and its tracked JSON report. |

## Real AI measurement

Measured on 2026-09-30 using the project's configured `codex/gpt-6-sol-medium`
profile, model `gpt-6-sol`, medium effort, `codex-cli 0.159.1`, production Gate
command id `flow.spec.gate`. Each fixture has an isolated Git root and starts the
Agent in its `agent-initial-cwd` subdirectory. No provider profile or trust setting
was changed.

| Phase | Exact input bytes | Provider launches / response calls | Sennel response retries | Observed tool commands / failed tools | Final evaluation |
| --- | ---: | ---: | ---: | ---: | --- |
| Draft | 150515 | 1 / 1 | 0 | 5 / 1 | Accepted content FAIL: goal's 17-second timeout conflicts with 29 seconds at `qa[1].answer`. |
| Spec | 150426 | 1 / 1 | 0 | 3 / 1 | Accepted content FAIL: goal's 17-second timeout conflicts with requirement R1's 29 seconds; exact R1 target retained. |

Both AI sessions initially attempted a missing `python` executable and recovered
with `python3` inside the same provider invocation. These are AI tool retries,
not Sennel response retries or new provider launches. Both used the supplied
absolute input path. No naturally occurring file-read failure was observed;
Sennel read recovery is demonstrated by the deterministic phase fixtures.
The complete paths, configured CLI arguments, every response output, usages,
tool commands and protocol evidence are in
[`file-read-reference-measurement.report.json`](file-read-reference-measurement.report.json).

An initial measurement seed lacked Git metadata, and Codex rejected it before
model execution (`Not inside a trusted directory`): one response call and three
transport launches per phase, correctly classified as provider failure. The seed
was corrected to an ordinary isolated Git repository; no trust bypass was added.
This setup failure is not counted as successful AI evaluation.

## Deterministic and fault-comparison status

The existing Draft artifact scenario, all five Spec artifact variants and the
retained Spec context-limit scenario passed (seven scenarios). Spec exhaustion
also passed, including saved typed group evidence, reload and zero-provider
restart refusal. Draft exhaustion passed after fixing the diagnostic-reader
boundary: the saved StepError/receipt and empty diagnostic evaluation remain;
fresh next-action selects `CANONICAL_ATTEMPT_BLOCKED`, and dispatcher restart
calls zero providers while preserving canonical state, catalog and activities.
Spec uses its existing `CANONICAL_ATTEMPT_RECOVERY_REQUIRED` stop. These are nine
passing phase scenarios across the final targeted runs.

The frozen recovery comparison passed both phases with retries enabled and failed
both with only the shared read-retry branch disabled. The same valid wire schema,
fixtures and assertions were used. All 667 source files were audited: only
`lib/agent-response-protocol.js` differs, precisely the three-line read retry
branch. Test SHA-256 values, source tree digest, exact mutation and per-phase
failure attribution are in
[`file-read-retry-fault-comparison.report.json`](file-read-retry-fault-comparison.report.json).
This demonstrates the known missing-retry fault; import failures and old-schema
rejections do not count as evidence. Both isolated copies were removed.
An earlier comparison was discarded because live source changed between copies;
the reported comparison clones both trees from one immutable seed.
That seed precedes the final initial-admission and internal-transport input
checks. The read-retry branch remains the same; those later boundary changes
are verified separately by their targeted tests.

Two unrelated existing failures were reproduced independently at base HEAD with
unchanged test/source files: Draft Review refusal (`definition-lifecycle-failure.test.js:590`,
expected false versus actual true) and the Spec route in
`plan-gate-repair-route.test.js:20` (`step is outside plan gate repair route: spec`).
They remain baseline failures, separate from board 6928 validation. The final
full-suite audit below also reproduces the other unrelated integration failures.

Initial reference refusals also suppress planning metrics and Draft error
issue-log publication. Dispatcher timing metadata under `.runtime/step-metadata`
remains transient and outside the canonical catalog; it is intentionally excluded
from the authority snapshot. Input creation failures from `mkdir`, `mkdtemp` or
`AtomicFile.write` retain the existing execution-failure contract. The reference
validation boundary and an inability to create the caller-owned input are
distinct. The two existing creation-failure tests and the retry-time input
change/removal test passed again with the final admission changes; the large
Spec recovery/downstream scenario also passed (four targeted tests).

## Regression results

The final unit run passed 976 of 977 tests, with only the independently reproduced
PlanGateRepairRoute baseline failure. Structure passed 38/38 on the final source;
E2E passed 43/43 and acceptance 6/6. All of these runs had zero skips and cancellations.
The final focused budget/admission run passed 40/40, the existing Task Review
failure cases passed 2/2, the existing inline Draft dispatch case passed 1/1,
and the final Draft/Spec exhaustion scenarios passed 2/2.

The required `npm test` finished with the following observed results. Its unit
scope ran before correction of one newly added evidence-corruption fixture;
its integration and structure scopes exposed regressions corrected afterward.
The full integration scope was not repeated after the final fixes. These counts
are the actual original invocation, not a reconstructed all-green result.

| Scope | Tests | Passed | Failed | Cancelled / skipped |
| --- | ---: | ---: | ---: | ---: |
| Unit | 976 | 974 | 2 | 0 / 0 |
| Integration | 3836 | 3808 | 28 | 0 / 0 |
| E2E | 43 | 43 | 0 | 0 / 0 |
| Acceptance | 6 | 6 | 0 | 0 / 0 |
| Structure | 38 | 37 | 1 | 0 / 0 |

All eight related integration failures passed unchanged assertions after the fixes:
five production-structure dependency cases, two Task Review immutable-error
cases, and one inline Draft dispatcher contract case. The final structure run
also passes the corresponding Draft dependency check. The remaining 20
integration failures were reproduced on detached base HEAD with the same tests;
no baseline failure was skipped, weakened or repaired outside this task.

| Base failure family | Reproduced failures |
| --- | ---: |
| Draft Review admission refusal | 1 |
| Approval repair dispatch | 1 |
| Full Flow worker handoff | 1 |
| Draft Refine fact-read rejection | 1 |
| Flow leaf ordering | 1 |
| Missing producer artifact recovery | 1 |
| Exhausted recovery error-code cases | 3 |
| Worker handoff authority/publication cases | 6 |
| Artifact contract inventory | 2 |
| Builtin provider profile inventory | 1 |
| Spec decision migration | 2 |

The isolated base comparison also passed both Task Review cases and the inline
Draft case, establishing these three as introduced regressions. Three existing
set-retry controls selected by the same name family also passed at base. All
baseline worktrees were removed. A redundant integration invocation was stopped
once detected; its cancellations are excluded from these reported results.

The immutable-error fix keeps the exact original error as `cause`, and saves
counts in the executor-owned incomplete failure's frozen `details`. It does not
mutate or unfreeze provider/protocol errors. Newly added accounting assertions
now read the injected live accounting or that executor failure, with every
numeric expectation retained. The new immutable adapter/protocol case checks
error identity, code, frozen state and unchanged own properties. Existing Task
Review tests were not edited.

Draft file diagnostics carry the public tooling code through typed digest-bearing
evidence. Shared `hasFileInput` provenance prevents these diagnostics being
reinterpreted as a semantic Gate judgment after reload. Non-file Draft failure
codes and reader behavior retain their existing contract; dispatcher control
was not changed. The unchanged inline dispatcher scenario passes.

`npm run test:agent` completed with 11 tests: 6 passed, 1 failed, 3 cancelled and
1 skipped. The failure is the unchanged repair-model test's missing
`response.baseRevision`; it calls `Agent.call` directly and does not use batching,
file references or the response protocol. The unchanged worker-handoff suite
reached its overall 480-second timeout after one success; its second case was
interrupted and the remaining two did not run. That interrupted path does not
execute Gate. These failures were not measured at base HEAD and are not claimed
as established baseline failures. The full agent suite is therefore not green;
the three cancelled callers' real-AI behavior remains unverified. The separate
Draft/Spec file-reference measurements above both passed.

Known limits: budgets are in-memory within a command invocation; this verification
does not claim cumulative limits across OS crash before persistence. Only the
configured Codex provider was measured. Known-fault detection is not completeness
against unknown faults or general model-quality assurance.

## Transport input validation and final review

Before an internal Agent transport retry, the existing provider admission guard
revalidates the same temporary input with `assertUnchanged`; a missing or changed
file stops before a second startup. The real Agent transport change/removal cases
pass with one provider launch and retain local-input evidence. Together with the
mixed transport/format/read case, the final targeted run passed 3/3.

In a separate isolated comparison, disabling only the `context.index > 0` input
validation branch makes the same two transport cases fail: actual startup count
is two while the required count is one. Source and test copies were checked for
identity and removed; original worktree bytes were unchanged. This comparison
is distinct from the frozen read-retry comparison above. Moving the unchanged
input-error class into dependency-free `agent-file-input-failure.js` then passed
both transport cases plus all six affected structure cases (8/8). This preserves
the pure Step/value dependency boundary without checker exclusions or an old
module re-export.

The implementation manager reviewed the main source changes and observed the
key results directly. Independent read-only review found no remaining acceptance
blocker: file identity, actual provider caps, cache settlement, full group evidence,
exact Attempt persistence and file failure stops satisfy the reviewed contract.
No dependency, host lifecycle hook, independent semantic retry/route or Service
filesystem read was added. Original Flow #521 and main repository state were
preserved; at verification time, changes were uncommitted on `feature/6928-agent-file-reference`.

Acceptance for board 6928 is complete. The repository-wide and real-agent suites
are not fully green for the reasons recorded above; no unmeasured provider or
crash-spanning guarantee is claimed. Task-owned execution logs were deleted after
preserving this report and the structured measurement/fault-comparison artifacts.

## Follow-up: retry prompt budget (2026-10-01)

The subsequent code review found that a valid initial file judgment could not
retry near its prompt limit: `GateOutputProtocolPolicy` appended 261 characters
after planning, exceeding either the logical or resolved invocation limit.
The fix reuses the immutable planned request on every response attempt.
`AgentFileReference.toPromptText()` and `GuardrailFileInput.toPromptText()` already
provide all the removed instructions, so no retry margin, extra group, or new
budget API is needed. Reusing the request also avoids the executor's extra
projection for a changed retry request. Actual `Agent.call()` retains its own
per-call invocation limit check.

All six shared policy callers were reviewed. The behavioral difference is in
Draft/Spec file-read retries; inline judgments and evidence collection/reduction
already reused their planned requests. Fresh cache bypass, file identity checks,
format/transport accounting, four-provider cap, prompt metrics, error evidence,
and Definition-owned semantic transitions retain their existing owners.

### Frozen regression comparison

The new `tests/integration/flow/gate-file-retry-prompt-budget.test.js` exercises
Draft/Spec through `checkGuardrail`, with three complete small rules and exact
UTF-8 file bytes. A successful control execution calibrates the initial request;
the retry execution has only 64 characters of remaining budget. Logical and
projected boundaries are separate cases, with ample logical headroom in the
projected case. Only the external provider and guardrail loader are faked.

- Base HEAD: `c9c1e855a91ccfb74b47230aec3dfe43056e0a30`, with the existing uncommitted 6928 implementation.
- Pre-fix `run-gate.js` SHA-256: `162f059db54590bbdc1bbff016044b3f771041ca1d128e287af04f02d746e2e1`.
- Post-fix `run-gate.js` SHA-256: `83476b395b81598b908da3fc89fb225b0e4cf0112e5b3ed5e4513d4acc253f41`.
- Identical frozen test SHA-256 before and after: `2238aa0d61cf09bea81f4eba400e9a2ca3f4cf0dfacabcf807e1ad7a8819b365`.
- Before: all four cases failed after the first typed file-read failure. Both logical cases reported `PROMPT_BATCH_OVERFLOW`; both projected cases reported `PROMPT_INVOCATION_PROJECTION_OVERFLOW`.
- After: all four passed. Draft recovered on the second provider call and Spec on the fourth, with the same request fields, complete rule group, input digest/bytes, fresh bypass responses, counted attempts, and file cleanup.

The projected regression uses a deterministic provider projection, not a real
model quality measurement. Three selected existing `Agent.projectInvocation`
tests separately verify actual invocation construction, provider template
wrappers, and refusal before spawning an oversized invocation.

### Targeted post-fix verification

The implementation manager executed and inspected these results directly.
No selected tests were duplicated between agents, and no full suite was run.

| Scope | Passed / run | Observable contract |
| --- | --- | --- |
| New retry-budget regression | 4 / 4 | Initial admission remains retryable at logical/projected boundaries in both phases; no extra rule group |
| Draft/Spec file Gate and Gate prompt batching | 30 / 30 | Inline/file selection, full rule grouping, format/read/transport retry, input-change stop, shared Requirement Gate execution |
| File judgment plan, response protocol, file reference, scoped provider budget, initial file admission | 32 / 32 | Freshness, cache settlement, safe initial refusal, input identity, combined provider caps, no partial PASS |
| Selected actual Agent invocation projection checks | 3 / 3 | Projection/materialization agreement, template overhead, pre-provider limit refusal |
| Draft/Spec production artifact and failure scenarios | 9 / 9 | Registered production paths, fourth-call recovery, saved evidence and reload, Spec/Acceptance consumption, exhaustion/restart refusal, no partial publication |

All 78 selected post-fix tests passed, with no failures, cancellations, or skips.
The five post-fix commands were:

```sh
node --test tests/integration/flow/gate-file-retry-prompt-budget.test.js
node --test tests/integration/flow/draft-file-gate.test.js tests/integration/flow/spec-file-gate.test.js tests/integration/flow/gate-prompt-batching.test.js
node --test tests/unit/gate-file-judgment.test.js tests/unit/agent-response-protocol.test.js tests/integration/lib/agent-file-reference.test.js tests/integration/lib/agent-response-protocol.test.js tests/integration/lib/prompt-provider-attempt-budget.test.js tests/integration/flow/gate-file-input-admission.test.js
node --test --test-name-pattern='projects the same transport|counts every provider-visible|refuses an oversized final projection' tests/integration/lib/agent-invocation-projection.test.js
node --test tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js tests/integration/flow-cli/file-read-exhaustion-scenario.test.js tests/integration/flow-cli/spec-file-failure-scenario.test.js
```

The existing real-model measurements above were not rerun: the initial prompt
and file contract are unchanged. This follow-up does not claim a new real-model
quality measurement or a fully green repository-wide suite.

Astra (high) reviewed the design and final patch independently, Sol (high)
implemented the fix and regression tests, and Luna (medium, read-only CLI)
identified the related verification scope. The manager checked the source delta,
valid regression scenarios, unchanged frozen test, downstream assertions, and
all final command results. The repair adds no dependency, state format, or Flow
route; verification was completed against the uncommitted implementation in its worktree.
