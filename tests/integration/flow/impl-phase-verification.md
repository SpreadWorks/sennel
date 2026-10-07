# Board 37e4 implementation-phase test verification

Scope: tests-first creation for phase 03. Product implementation and all-green
acceptance belong to board `3a50`. The captured current contract is
[impl-phase-board-source.md](impl-phase-board-source.md); parent `67fd` and the
twelve legacy leaf designs define the shared boundaries and semantic Results.

Work branch: `codex/37e4`. Worktree: `.sennel/worktree/37e4`.
Base: `main`, `340cf933bac55be0592417e16a67449698ac09a4`.
No production change, Flow start, board write, commit, merge, push or publication
is part of this deliverable. Offline scenarios create only owned temporary Flow
roots.

## Scope and reuse

The fixed responsibility manifest has seven Flow leaves and five Task leaves,
using the existing phase-03 manifest and `TaskStepIdentity`. The existing
`StructureChecker`, `ProductionRegistrations`, `StepRegistration`,
`ServiceBoundaryCoverage`, `PrepareExecutionObserver`, sole
`STEP_RESULT_REGISTRY`, canonical Store, source-worker handoff and current
Retro remain the authorities.

The three board entrypoints are supplemented by a concrete Result contract
test and one cumulative new-Flow case. The cumulative case extends the existing
`PrepareArtifactScenario` and `RequirementTestPhaseScenario` through actual
Draft and Spec production without inserting intermediate success artifacts.
The shared phase fixture accepts a normally prepared scenario; its existing
Spec-only path retains its immutable Draft seed.

Tests do not implement missing production contracts. Missing registration,
Result and receipt assertions remain normal initial reds. A positive isolated
structure or Service fixture proves checker behavior only, never product
preparation, production publication or full-Flow success.

Documentation freshness was stale at work start; `sennel docs build` was
recommended. Source is authoritative. No generated docs update is required by
this tests-only scope.

## Outcome-to-condition graph

| Board outcome | Legal producer / necessary condition | Storage and reload | Actual consumer / fixed assertion |
| --- | --- | --- | --- |
| I00 cumulative new Flow | `set-init → prepare → Draft → Spec → approval → Requirement Test Gate → implement` | Same run/spec identity; real Draft bytes and promoted `tests.source`; fresh managers between phase joins | Real Spec input equals saved Draft; real implementation, test chain and current Retro; owning semantic Results and receipt identities |
| I01 all Tasks / no Task | Approved ordered TaskCollection and promoted tests; Task workers and Reviews/Gates; legal empty-Task Spec has no requirements | Task frontier/parent statuses, source lineage, test producer Activity and review reference survive reload | Every Task precedes integration; `test-execute → test-result-review → impl-review → impl-gate`; real Retro reads exact execution; empty case preserves current `NO_REQUIREMENTS` stop without fabricated requirements |
| I02 bounded Task convergence | Normal no-change/Review/host filter/repair and Gate-selected next implementation round | Two implementation rounds, four durable semantic Reviews each; Attempt sequences remain distinct; final repair and quality handoff retained | Real Gate/Acceptance evidence readers preserve final unreviewed source/findings; no fifth Review or completed PASS fabrication |
| I03 no-change / UNAVAILABLE | Canonical no-change reason/empty manifest; production zero-effect Review failure classification | Saved failure artifact, continuation and source manifest; fresh accounting | Failure never adds semantic ordinal; Gate/unreviewed slice retains source obligation; legal no-change advances without forged worker evidence |
| I04 permissions and identity refusal | Current Review episode, four host guards, complete finding identity, exact repair apply set and mutation | Binding, counters, catalog and source bytes unchanged after refusal | Host filter and source handoff reject unknown/duplicate finding, other Task/round/baseline, readonly mutation, disallowed Git/managed paths and missing mutation |
| I05 complete immutable input | Normal worker/reviewer materialization of full UTF-8 source and obligations | Producer bytes/hash/length and immutable references; claim/seal distinguished from completion | Worker and Review consume same complete head/tail bytes; changed/missing reference and input/argv/file/context failures refuse or stop without PASS |
| I06 test meaning versus evidence | Promoted source and real test process; exit 1 versus spawn/signal/timeout | Canonical `test.execute` and source-bound result Review survive reload | Valid evidence Review does not erase semantic failure; tooling failure stops without semantic retry or false successful test |
| I07 test-chain reconstruction | Real ImplReview finding → readonly triage → actual repair mutation/recurrence resolution | Original repair Attempt, invalidated former execution/review fingerprint, new test Attempt and quality checkpoint | Real reexecution/result Review/Gate/Retro use new producer; no former PASS borrowed |
| I08 nominal PASS cannot erase obligations | Genuine Review/triage/repair and evaluator PASS or explicit all-reject/PASS/ADVISORY policy | Complete identity, sequence, apply set, must-fix obligation and reason receipt | Gate stops on mismatched/open obligation; unnecessary worker stages have no invented success Result/artifact/Attempt; existing max4/max5 policy is reused |
| I09 interrupted publication / replay | Normal claims, seals, publication and real Store write fault boundaries | Before-commit and committed-response-loss/readback/cleanup are separate; fresh canonical readback | Only exact receipt replay; worker/evaluator/metric/lineage/Task promotion once; wrong direct command refuses before effects |

Scenario cases cover causal connections. Existing lower-level decision tests
remain responsible for isolated rules; the frozen regression union below
includes their concrete files. A later assertion masked by an earlier contract
failure is authored coverage, not measured successful product behavior.

## Fixed semantic Result table

These are inspection expectations derived from the captured legacy leaf tables.
They do not register any product Result or create an alternate runtime registry.
Each common error uses the existing `StepErrorResult`.

| Step | Class | kind | type | Source board |
| --- | --- | --- | --- | --- |
| `implement` | `ImplementWorkerRequiredResult` | `implement-worker-required` | `loop-required` | `ede4` |
| `implement` | `ImplementAppliedResult` | `implement-applied` | `completed` | `ede4` |
| `implement` | `ImplementExistingCompletionResult` | `implement-existing-completion` | `completed` | `ede4` |
| `implement` | `ImplementQualityIssueResult` | `implement-quality-issue` | `completed` | `ede4` |
| `implement` | `StepErrorResult` | `implement-error` | `error` | `ede4` |
| `task-impl` | `TaskImplementationWorkerRequiredResult` | `task-impl-worker-required` | `loop-required` | `fdc7` |
| `task-impl` | `TaskImplementationAppliedResult` | `task-impl-applied` | `completed` | `fdc7` |
| `task-impl` | `TaskImplementationNoChangeResult` | `task-impl-no-change` | `completed` | `fdc7` |
| `task-impl` | `TaskImplementationQualityIssueResult` | `task-impl-quality-issue` | `completed` | `fdc7` |
| `task-impl` | `StepErrorResult` | `task-impl-error` | `error` | `fdc7` |
| `task-review` | `TaskReviewExecutionRequiredResult` | `task-review-execution-required` | `loop-required` | `9a58` |
| `task-review` | `TaskReviewFindingsResult` | `task-review-findings` | `branch-required` | `9a58` |
| `task-review` | `TaskReviewGateRequiredResult` | `task-review-gate-required` | `completed` | `9a58` |
| `task-review` | `TaskReviewNoChangeCompletedResult` | `task-review-no-change-completed` | `completed` | `9a58` |
| `task-review` | `TaskReviewUnavailableResult` | `task-review-unavailable` | `completed` | `9a58` |
| `task-review` | `StepErrorResult` | `task-review-error` | `error` | `9a58` |
| `task-triage` | `TaskTriageFilterRequiredResult` | `task-triage-filter-required` | `user-input-required` | `28a5` |
| `task-triage` | `TaskTriageRepairRequiredResult` | `task-triage-repair-required` | `branch-required` | `28a5` |
| `task-triage` | `TaskTriageGateRequiredResult` | `task-triage-gate-required` | `completed` | `28a5` |
| `task-triage` | `TaskTriageNoChangeCompletedResult` | `task-triage-no-change-completed` | `completed` | `28a5` |
| `task-triage` | `TaskTriageCorrectionRequiredResult` | `task-triage-correction-required` | `loop-required` | `28a5` |
| `task-triage` | `TaskTriageUnreviewedGateResult` | `task-triage-unreviewed-gate` | `branch-required` | `28a5` |
| `task-triage` | `StepErrorResult` | `task-triage-error` | `error` | `28a5` |
| `task-repair` | `TaskRepairWorkerRequiredResult` | `task-repair-worker-required` | `loop-required` | `cbd1` |
| `task-repair` | `TaskRepairReviewRequiredResult` | `task-repair-review-required` | `loop-required` | `cbd1` |
| `task-repair` | `TaskRepairUnreviewedGateResult` | `task-repair-unreviewed-gate` | `branch-required` | `cbd1` |
| `task-repair` | `StepErrorResult` | `task-repair-error` | `error` | `cbd1` |
| `task-gate` | `TaskGateExecutionRequiredResult` | `task-gate-execution-required` | `loop-required` | `54d4` |
| `task-gate` | `TaskGatePassedResult` | `task-gate-passed` | `completed` | `54d4` |
| `task-gate` | `TaskGateRepairRequiredResult` | `task-gate-repair-required` | `loop-required` | `54d4` |
| `task-gate` | `TaskGateRetryRequiredResult` | `task-gate-retry-required` | `loop-required` | `54d4` |
| `task-gate` | `TaskGateDeferredResult` | `task-gate-deferred` | `branch-required` | `54d4` |
| `task-gate` | `TaskGateAwaitingDecisionResult` | `task-gate-awaiting-decision` | `user-input-required` | `54d4` |
| `task-gate` | `StepErrorResult` | `task-gate-error` | `error` | `54d4` |
| `test-execute` | `TestExecutionRequiredResult` | `test-execute-execution-required` | `loop-required` | `fd3b` |
| `test-execute` | `TestExecutionObservedResult` | `test-execute-observed` | `completed` | `fd3b` |
| `test-execute` | `StepErrorResult` | `test-execute-error` | `error` | `fd3b` |
| `test-result-review` | `TestEvidenceAcceptedResult` | `test-result-review-evidence-accepted` | `completed` | `57ec` |
| `test-result-review` | `TestEvidenceRejectedResult` | `test-result-review-evidence-rejected` | `loop-required` | `57ec` |
| `test-result-review` | `StepErrorResult` | `test-result-review-error` | `error` | `57ec` |
| `impl-review` | `ImplReviewExecutionRequiredResult` | `impl-review-execution-required` | `loop-required` | `6167` |
| `impl-review` | `ImplReviewPassedResult` | `impl-review-passed` | `completed` | `6167` |
| `impl-review` | `ImplReviewAdvisoryResult` | `impl-review-advisory` | `completed` | `6167` |
| `impl-review` | `ImplReviewRejectedResult` | `impl-review-rejected` | `branch-required` | `6167` |
| `impl-review` | `ImplReviewToolingResult` | `impl-review-tooling` | `user-input-required` | `6167` |
| `impl-review` | `StepErrorResult` | `impl-review-error` | `error` | `6167` |
| `impl-triage` | `ImplTriageWorkerRequiredResult` | `impl-triage-worker-required` | `loop-required` | `5f3f` |
| `impl-triage` | `ImplTriageRepairRequiredResult` | `impl-triage-repair-required` | `branch-required` | `5f3f` |
| `impl-triage` | `ImplTriageGateRequiredResult` | `impl-triage-gate-required` | `completed` | `5f3f` |
| `impl-triage` | `StepErrorResult` | `impl-triage-error` | `error` | `5f3f` |
| `impl-repair` | `ImplRepairWorkerRequiredResult` | `impl-repair-worker-required` | `loop-required` | `8504` |
| `impl-repair` | `ImplRepairAppliedResult` | `impl-repair-applied` | `loop-required` | `8504` |
| `impl-repair` | `ImplRepairQualityIssueResult` | `impl-repair-quality-issue` | `loop-required` | `8504` |
| `impl-repair` | `StepErrorResult` | `impl-repair-error` | `error` | `8504` |
| `impl-gate` | `ImplGateExecutionRequiredResult` | `impl-gate-execution-required` | `loop-required` | `9eec` |
| `impl-gate` | `ImplGatePassedResult` | `impl-gate-passed` | `completed` | `9eec` |
| `impl-gate` | `ImplGateEvidenceRefreshResult` | `impl-gate-evidence-refresh` | `loop-required` | `9eec` |
| `impl-gate` | `ImplGateSemanticFailureResult` | `impl-gate-semantic-failure` | `branch-required` | `9eec` |
| `impl-gate` | `ImplGateAwaitingDecisionResult` | `impl-gate-awaiting-decision` | `user-input-required` | `9eec` |
| `impl-gate` | `StepErrorResult` | `impl-gate-error` | `error` | `9eec` |

## Verification commands

Commands were expanded and deduplicated before verification. The old
per-Step command lists are superseded by phase entrypoints, while their
existing relevant regression files are retained. Future 04/05 initial reds do
not form part of the phase-03 acceptance set.

### phase

```sh
node --test --test-concurrency=4 tests/structure/impl-phase.test.js tests/integration/flow/impl-phase-service-boundary-coverage.test.js tests/integration/flow/impl-phase-result-contract.test.js tests/integration/flow/impl-phase-publication-observer.test.js tests/integration/flow-cli/impl-phase-artifact-scenario.test.js tests/integration/flow-cli/impl-phase-new-flow-scenario.test.js
```

### checker

```sh
node --test --test-concurrency=4 tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/structure/execution-routing-provenance.test.js tests/structure/constructor-invariant-contract.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/integration/structure-phase-manifest.test.js tests/unit/structure-rules.test.js
```

### currentScopes

```sh
node --test --test-concurrency=4 tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js tests/structure/requirement-test.test.js
```

### currentDI

```sh
node --test --test-concurrency=4 tests/integration/flow/service-boundary-coverage.test.js tests/integration/flow/spec-service-boundary-coverage.test.js tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow/requirement-test-service-boundary-coverage.test.js tests/integration/flow/prepare-execution-observer.test.js
```

### currentScenarios

```sh
node --test --test-concurrency=4 tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js tests/integration/flow-cli/requirement-test-phase-scenario.test.js
```

### regressions

```sh
node --test --test-concurrency=4 tests/unit/structured-step-result-contract.test.js tests/unit/flow-engine-step-result.test.js tests/integration/flow/review-whole-file-input.test.js tests/integration/flow/worker-artifact-handoff.test.js tests/integration/flow/task-review-causal-scenarios.test.js tests/integration/flow/task-review-round-exhaustion.test.js tests/integration/flow/gate-transition-boundary.test.js tests/integration/flow/repair-state-identity.test.js tests/integration/flow/non-gate-transition-boundary.test.js tests/integration/flow/source-handoff-checkpoint.test.js tests/integration/flow/source-handoff-settlement-admission.test.js tests/integration/flow/gate-prompt-batching.test.js tests/integration/flow/task-canonical-context.test.js tests/integration/flow/task-source-handoff-recovery.test.js tests/integration/flow/task-review-accounting.test.js tests/integration/flow/task-review-no-change-continuation.test.js tests/integration/flow/task-review-publication-binding.test.js tests/integration/flow/task-review-host-filter.test.js tests/integration/flow/task-review-stage-transition.test.js tests/integration/flow/spec-gate-result-settlement.test.js tests/integration/flow/spec-gate-post-failure.test.js tests/integration/flow/test-execute-spec-local-summary.test.js tests/integration/flow/test-execute-requirement-disposition.test.js tests/integration/flow/shared-spec-test-execution.test.js tests/integration/flow/run-test-result-review-clean-checkout.test.js tests/integration/flow/impl-review-proposal.test.js tests/integration/flow/review-work-unit.test.js tests/integration/flow/review-recurrence.test.js tests/integration/flow/impl-loop-batching-verification.test.js tests/integration/flow/nonblocking.test.js tests/integration/flow/finding-gate-readiness.test.js tests/integration/flow/set-step-impl-repair.test.js tests/integration/flow/run-acceptance-review-source.test.js tests/integration/flow/repair-attempt-lineage.test.js tests/integration/flow/gate-source-authority.test.js tests/integration/flow/gate-requirement-context.test.js tests/integration/flow/gate-noop-rerun-guard.test.js tests/unit/draft-step-definition-settlement.test.js tests/unit/spec-step-result.test.js tests/unit/draft-step-binding.test.js tests/integration/flow/draft-step-result-settlement.test.js
```

The separate whole structure aggregate is `npm run test:structure`.
No real AI provider/prompt/agent implementation changed, so no real-agent suite
is needed for this tests-only patch.

## Final verification and acceptance record

The final affected command is the unfiltered six-file phase command above with
caller-owned TMPDIR prepared by the existing TestTemporaryRoot API. Final
measurement: `phase-final-r3.log`, **203 tests: 69 pass / 134 initial contract
failures / 0 skip / 0 cancel**. It includes the corrected latest-Attempt terminal
checks and real second-round Gate settlement. The one non-Assertion failure is
the independently reproduced post-rename catalog/Activity corruption. There
are no syntax/import/setup failures in the final phase result.

The cumulative I00 case produces one new Flow through Prepare, Draft, Spec,
Approval, Requirement Test promotion, Task execution, integration and actual
Retro. Its complete artifact/producer/consumer assertions run before the final
missing `implement` StepResult assertion. It is measured connection evidence
for the current legacy path, not proof of the absent phase-03 Result migration.

The joint I02 case executes both real Gates. After four Reviews in the final
round it preserves exact unreviewed evidence, reads the fresh Definition's
defer decision, rejects a third implementation round without effects, settles
through the real command, reaches test-execute and retains both quality issues.
Its final missing-Result red remains separate from those reached guarantees.

| Verification set | Measured result | Interpretation |
| --- | --- | --- |
| Final phase structure / actual DI / Results / observer / scenarios / cumulative | 69/203 pass; 134 initial reds | Fixed tests-first contract; no product acceptance |
| Existing phase structure | 8/8 pass | Draft, Spec, 01 and 02 retained |
| Existing Draft/Spec/01/02 scenarios | 181/181 pass | Shared prepared-fixture extension retains real phase production and downstream use |
| Shared checker regressions | 285/288 pass | Three failures reproduce unchanged at base |
| Existing actual DI | 29/30 pass | One incomplete observation snapshot failure reproduces at base |
| Deduplicated related regression union | 590/609 pass | Nineteen worker-handoff failures reproduce with identical names/codes/initial error text at base |
| Whole structure aggregate | 328/342 pass | Fourteen phase-03 missing-registration reds, recorded separately |
| Publication observer real Draft control | 1/1 pass | Actual save/fresh read/foreign digest rejection/exact Activity replay, also included final phase command |

The evidence directory retains exact logs and `verification-records.json`
with per-case errors, hashes, baseline comparisons and scope summaries.
`final-candidate-final.json` records the unchanged production source digest,
base commit, branch, complete changed/added file set and test/support digests.
`final-dirty-final.patch` records existing-file changes; new files remain in the
reviewable worktree. The final board readback matches the captured body exactly.

Acceptance audit: fixed all-12 scope, lawful checker/DI positive controls and
single-fault removal controls; real production registration/Result deficiencies;
all nine authored causal outcomes, budgets, current/historical identities and
producer-to-consumer joins; meaningful initial reds; full fixed command results
and baseline separation; no weakened expectations/skips; no product changes or
delivery operations. **Board 37e4 tests-first deliverable is complete.** Product
all-green acceptance remains unachieved and belongs to 3a50; masked later
guarantees are explicitly recorded, not claimed successful.

Source revision is fixed at the recorded start commit. During this task an
external operation advanced main; this worktree was not rebased or merged.
Integration into newer source therefore requires the normal later candidate
verification. No worktree/source outside this task was modified. All task-owned
temporary execution processes completed; comparison worktrees and final tmpfs
roots were removed. Necessary evidence and the codex/37e4 worktree remain.

## Missing shared production contracts and measured failures

The existing named worker, Review and Gate adapters remain the primary contracts.
Only host-filter and test-chain registration adapters are missing; their new
selection/projection/execution interfaces belong in the existing
`execution-admission.js` and `test-chain-transition-facts.js` responsibilities.
The tests do not require an implementation-only adapter module or aliases for
the existing shared adapters.

The Result-only boundary follows the existing
`settleDraftStepResult` / `settleSpecStepResult` /
`settlePrepareStepResult` / `settleRequirementTestStepResult` convention.
Tests fix `settleImplStepResult(stepId, result)` and
`settleTaskStepResult(stepId, result)` in the same Definition owner. Restored
Results must produce the same Settlement class, serialized target/effects and
exact Connector class; no additional facts are passed.

Terminal assertions cannot borrow an execution request. They select a
target-connection or failure receipt owned by the exact completion Activity;
claim-only cases explicitly use `assertClaims`. The publication observer
delegates every real save unchanged, retains the original typed save input,
then asks the existing `findStepSettlementReceipt` reader to authenticate
the exact intent after manager disposal. Existing `FlowActivity` and
`ActivityTransition.apply` replay only that one owning transition on its
observed predecessor. This establishes the target from the same transaction,
not from an unrelated later Activity.

The observer's positive control runs the real existing Draft dispatcher and
writer, reloads a fresh manager, authenticates its real receipt, replays the
owning Activity and rejects a correctly self-signed foreign publication digest.
The control proves this test support works beyond the phase-03 missing-Result
guards; it does not substitute Draft acceptance for implementation acceptance.

| Measured boundary | Finding and later masked assertions |
| --- | --- |
| Fixed 12 production leaves | Both compositions/entries and actual lookup registrations are absent; production preparation is authored but not yet reachable |
| Single Result registry | 48 semantic classes plus 12 common Error contracts are absent; two pure phase settlement APIs are absent |
| No-Task entry | Schema-valid empty Spec first reaches its real strict Gate stop, then a source-bound explicit nonblocking decision and normal Approval/Requirement lifecycle reach `implement`; source handoff rejects empty canonical requirements, so integration/Retro assertions remain masked |
| Rejected ImplReview | Real internal registry post fails with `adapter.resetSteps is not a function`; readonly triage, finding classification and repaired integration-chain assertions remain masked at that earlier boundary |
| Nominal Task Gate PASS | Four real rejected Reviews and unrepairable zero-mutation repairs retain the must-fix obligation; an actual PASS evaluator and normal Gate post nevertheless complete the Task |
| Publication-only Review | A genuine sealed Review is published without terminal Result/receipt while the Review remains active; accounting incorrectly reports one completed semantic Review |
| Catalog write exception after rename | The catalog becomes visible while physical rollback restores older Activity bytes; a fresh reader reports catalog/Activity hash corruption |
| Named 2MiB input bound | Real parser rejects MAX+1 metadata, preserves state/budget, and restores the original request; it propagates an untyped Error instead of a typed boundary refusal |

Final-candidate regression evidence separates existing failures from new initial
reds. Shared checker: 285/288; its three source-shaped injection failures
reproduce with unchanged tests at base commit. Existing production DI: 29/30;
the sole incomplete observer-registration snapshot failure also reproduces at
base. Existing related regression union: 590/609; all nineteen
`worker-artifact-handoff.test.js` failures reproduce with the same names,
error codes and initial error text at base. Temporary detached worktrees were
removed after comparison. Tests and product behavior were not weakened to hide
these failures.

The whole structure aggregate is separately measured: 328/342 passed, with
the fourteen phase-03 missing-registration initial reds. Earlier one-file,
subset and invalid-fixture development logs remain labeled historical. The
final changed phase set also includes
`tests/integration/flow/impl-phase-publication-observer.test.js`.
