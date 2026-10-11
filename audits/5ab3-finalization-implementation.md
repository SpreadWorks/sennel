# 5ab3 Finalization implementation and verification

Status: accepted for board 5ab3's local implementation scope. Every required
finalization target passed on the same candidate 9; existing baseline regression
failures remain explicitly recorded below.

The implementation migrates `finalize-commit`, `finalize-merge`, `finalize-sync`, and
`finalize-cleanup` together. The existing canonical Version Store, outbox,
repository operation lock, approvals, Git markers, merge transaction and cleanup
journal remain their respective authorities.

## Candidate and scope

- Board: `5ab3`; parent `67fd`; accepted predecessor `6af5`.
- Branch: `codex/5ab3`.
- Worktree: `.sennel/worktree/5ab3`.
- Base: `d2de9168115a341e38aee5fe817de129ac2cb980`.
- No implementation Flow was started. No commit, merge, push, publication or
  board write is part of this delivery.
- Source and test hashes, captured diffs, board snapshots and test logs are in
  `.tmp/5ab3/`. Candidate 9 and final acceptance evidence are recorded below.

## Ownership and production routes

| Boundary | Owner and implementation |
| --- | --- |
| Acquired execution facts | `FinalizationExecutionIdentity` binds run, Spec, source Attempt ID/sequence, approval Action, expected refs, report publication, main authority, outbox key/attempt, authorization and journal. It exposes no reader or manager. |
| Inputs and Services | Each leaf has its own Input, Service and Step. Services hold private acquired inputs and a save-only `FinalizationSettlementWriter`; `StepRegistration.create` supplies their declared argument types. |
| Semantic outcomes | Each Step converts its acquired observation to its concrete Result. `finalization-result-factory.js` is reused by canonical evidence validation, so outcome interpretation is not copied into callers. |
| Settlement | `settleFinalizationStepResult(stepId, result)` in Definition alone chooses Execution, target connection, PR Await, Failure or Completion. Only the three target connections have Connectors. |
| Canonical publication | The existing Store verifies binding, acquired command publication, Result, selected Settlement and exact replay; it publishes source confirmation, receipt, outbox and target/lifecycle together. |
| Command entry | All four commands, registry pre/post/error hooks and dispatch use `finalizationStepRegistrations` and their shared select/project/execute contract. Effect preparation precedes the outbox claim; the Execution Result is durable before external effects. |
| Read-only projection | `get-next-action` reads saved Results/Settlements. A keyed PR Result projects Await and cannot fabricate sync or cleanup. |
| Recovery | Exact outbox recovery reuses the existing Definition decision, opens the same leaf with a new canonical Attempt, preserves old failures, and writes a new bound Execution checkpoint. Interrupted-sync recovery commits its selected warning outcome, audit, outbox and cleanup activation together. |
| Cleanup and final consumers | Cleanup obtains main authority before removal, resumes the existing six journal phases, and publishes source confirmation plus the real `flow_finalized` Activity in one Version transaction. Finalized replay authenticates the saved receipt and projects its original public result. Status and last-finalized report readers use that same canonical main authority. |

The single `STEP_RESULT_REGISTRY` contains the following kinds; all four leaves
use the existing common `StepErrorResult` for semantic errors.

| Leaf | `loop-required` | `completed` |
| --- | --- | --- |
| commit | `finalize-commit-execution-required` | `finalize-commit-created`, `finalize-commit-unchanged` |
| merge | `finalize-merge-execution-required` | `finalize-merge-squashed`, `finalize-merge-policy-skipped`, `finalize-merge-pr-opened` |
| sync | `finalize-sync-execution-required` | `finalize-sync-built`, `finalize-sync-unchanged`, `finalize-sync-skipped-with-warning` |
| cleanup | `finalize-cleanup-execution-required` | `finalize-cleanup-completed`, `finalize-cleanup-completed-with-warning` |

Git, remote PR publication, docs execution and filesystem teardown are external
effects, not one cross-system transaction. Original execution identities,
markers, expected-ref checks, remote operation keys and journal readback make
their recovery evidence explicit. Admission refusal and publication failure
preserve canonical state; they are not converted to semantic retry outcomes.

## Required prerequisite and test-infrastructure corrections

The real managed-worktree producer exposed a pre-existing Task Gate acquisition
error before finalization: the evaluator read the worktree, while the post-hook
read the main checkout. The two acquisition call sites now use the existing
execution root. The identical F00 scenario reproduced the original mismatch at
the base commit; `store-worktree-f00-baseline.log` retains that comparison.
Canonical artifacts still use their existing main-repository authority.

The same cumulative producer exposed Report post-hook acquisition through a
main-side manager while the command ran in its managed worktree. Before/after
file, index, diff and status snapshots were identical: the compared root was
wrong. The existing `executionRoot(state)` API now resolves the execution
checkout from the acquired state, while artifact validation uses the canonical
Spec location. The exact frozen F00 scenario passed after this correction.

Finalization acquisition now reads `state.execution.baseBranch/featureBranch`
from canonical state. Reading projected top-level fields had recorded null
expected refs. The actual ref values are acquired before effects and checked
again before execution; a direct Flow legitimately has no feature ref.

The external Review worker fake also opened linked worktrees as ordinary main
checkouts. It now uses the production worktree/main-root discovery APIs and one
correctly bound manager for both Task and Flow Review. Its protocol, sealing
and expected results are unchanged.

The PR fake previously returned only a number even when the production CLI
requested JSON body fields. It now projects the requested fields from the same
fake remote records, preserving every identity assertion. This matches the
[GitHub CLI JSON field contract](https://cli.github.com/manual/gh_pr_list).

Three operation-lock cleanup callbacks were registered after fixture deletion,
so passing scenarios failed in teardown because their lock authority directory
was already removed. Registering lock release before fixture creation restores
the required cleanup order; behavioral assertions remain unchanged.

The existing merge transaction recognizes `added in both` in Git 2.34's
three-tree conflict output as well as `changed in both`. The original add/add
conflict recovery test detects the missing classification. The installed Git
does not support modern `--write-tree`; the implementation keeps its existing
API. The output labels are defined in the
[Git 2.34 implementation](https://raw.githubusercontent.com/git/git/v2.34.1/builtin/merge-tree.c).

The common structural checker was extended for immutable declared range
origins, a worker subset of the complete Flow range, and multiple registered
phase projections. Existing positive and negative contracts are retained.

Registered cleanup additionally preserves the distinction between admission,
required audit/Store persistence failure, and an actual Git effect failure.
The existing exact receipt capability can authenticate a current Execution
checkpoint, so repeated pre-hooks consume its saved receipt without rewriting
canonical bytes. An actual partial teardown Error remains a common Error
Result; recovery authenticates the original journal Execution receipt, exact
outbox claim, required audit, immutable refs and the reality of each completed
phase before using the existing one-time exact reopen.

The same proof can reacquire a pending reopened Attempt whose checkpoint save
failed. It permits only the canonical reopened identity and original immutable
authority, then saves the missing Execution Result through the regular Step.
It neither reopens twice nor invents a completed outcome. Consumed recovery
receipts survive another failure and completion, including the public typed
outbox projection. Successful rescue data is stored before the terminal
publication and is available in Completion replay.

The merge authority handoff now uses normal Git checkout after the existing
preflight and expected-SHA publication. Forced checkout had overwritten the
tracked canonical ledger, state and catalog with an old failed Attempt after
an exact recovery. The original F04 producer demonstrated this rollback;
isolated Git comparison confirms normal checkout preserves the current bytes,
index and history. No caller restores or fabricates canonical state.

Merge readiness, acquisition and preparation revalidation use the existing
`executionRoot(state)` API, including when recovery is invoked from main.
The retained genuine pre-sync producer successfully resumed the same reopened
Attempt through the public CLI, preserving its original failure and recovery
receipt. The merge-to-sync Connector exposes a pending sync frontier, as the
original lifecycle and frozen recovery scenarios require; ordinary claim
remains the only owner of sync activation. The newly authored direct test's
setup now performs that same real claim.

Completion replay reads the Report of its authenticated Spec through the
existing report reader's explicit selection. The global latest pointer is
still used by `report show`, but cannot select a different report for an older
cleanup receipt. A genuine completed producer detects the violation before
the fix and passes the identical assertions afterward. The regression changes
only the external latest pointer; it does not invent a foreign canonical Flow
or report. Replay preserves its report, warnings, authorization, assurance,
receipt, canonical bytes, Git state and the independently moved pointer.

The old merge pre-hook's independent downstream reset was removed. Exact
recovery already resets the selected suffix together with the reopened Attempt
and outbox. A repaired Git conflict does not authorize an ordinary command to
reset state before its failed outbox rejects execution. The existing recovery
required error now exposes the shared admission classification, so dispatcher
and lifecycle writers preserve the original failure. The identical genuine
producer regression fails before this fix (all three canonical files changed)
and passes afterward, preserving Git, Attempt, outbox, Report, skipped suffix
and the unconsumed recovery allowance.

The managed cleanup scenarios exposed untracked `.sennel/output/analysis.json`
as runtime residue. Cleanup now obtains the exact observed runtime-owned paths
through the existing `FlowRepositoryRuntimeArtifactRegistry.owns` contract and
passes them to the existing removal preflight. Unknown implementation, Spec,
configuration and submodule changes retain their refusal behavior. Runtime
output is not added to implementation commits or broadly ignored.

Cleanup also verifies the actual managed target's binding and owner before
claiming its outbox, using the existing binding store and operation lock. A
different owner is an admission refusal and preserves canonical state, Git,
binding, worktree and the absent journal. Restoring the exact owner permits the
normal six-phase teardown and main-side consumers. The normal managed route
and every checkpoint interruption passed targeted verification; the exact
owner refusal/restoration group passed 3/3 with its original expectations.

The support journal reader had treated an uncreated journal directory as an
AtomicJsonFile authority. It now uses the existing domain readonly journal
API, which returns null for legitimate absence and validates a present journal.
The frozen null, owner, Git and canonical-state assertions are unchanged;
production does not create a journal directory on admission refusal.

## Acceptance matrix

| Board condition | Verification and required evidence | Status |
| --- | --- | --- |
| 1. Predecessor, structure, real DI and phase scenarios green | Accepted predecessor snapshot; dedicated structure 88/88; complete structure 972/972; actual DI and frozen phase scenarios together 67/67 | Passed |
| 2. Report through approvals, Git, skip/squash/PR, sync, cleanup and final consumers | Final candidate F00–F03: actual canonical producers, Git repositories, local bare origin, manual/auto approval, manager reload and report/status reads | Passed |
| 3. Failure, recovery, safe rejection, force and auto-rescue | Final candidate F04, F05, F07, including real squash/pre-sync conflicts, exact recovery, dirty/busy/SHA/status/owner refusal, force and auto-rescue; recovery and merge transaction evidence | Passed |
| 4. Every journal phase, response loss, replay and no duplicate effects | Final candidate F06/F07: all six managed journal checkpoints, effect/Store response loss, exact finalized replay and mutation refusal; registered Completion atomicity 12/12 | Passed |
| 5. Reload preserves identities, diagnostics, Git state and consumer input | Frozen scenarios reconstruct managers; execution/receipt observers bind original saves; post-removal main consumers and scoped Report replay pass; Result/replay/recovery 113/113 | Passed |
| 6. Revisions, diff, case logs and regressions recorded | Candidate 9 manifest/patch, complete six-command run manifest, case-level final evidence, immutable base comparisons and final delivery patch | Passed |
| 7. No weaker expectations, skips or combined partial success | Every mandatory target has a complete candidate-9 run with zero skips/TODO/cancellations; earlier failed/partial/interrupted runs remain separate history; regression failures remain failures | Passed |

## Existing regressions and interpretation

The six board-listed existing regression files produced 26 passes and 16
failures again in `required-regressions-candidate-9.log`. The 16 failures occur in their old
pre-finalization setup, which lacks the canonical producer prerequisites now
required by admission. The same 16 failures were reproduced at the untouched
base in isolated comparisons (`baseline-cleanup-regressions.log` and
`baseline-additional-regressions.log`). Names, codes and failure types match;
15 full diagnostics match, while one commit-scope fixture now detects missing
Report before missing FinalRegression. That unchanged fixture creates only an
initial Flow and never runs either producer; both versions stop before staging
or committing. The diagnostic difference is retained, not hidden as a full
message match. Test files and expected results were not changed. These failures
are recorded, not counted as finalization coverage or
as an all-repository green result. The lawful frozen phase scenarios must
independently demonstrate the required finalization behavior.

The additional shared-boundary regression run produced 66 passes and 23
failures. All 23 failure names, codes and error messages match the base commit;
there are no newly attributable failures. The comparison is in
`shared-boundary-baseline-comparison.json`. The archive comparison's three Git
inventory failures were discarded and replaced with the exact artifact
contract run in a clean detached base worktree (26/26); those setup failures
are not represented as improvements.

`npm run test:agent` completed with 12 passes and one existing optional
historical-fixture skip in `agent-regressions.log`. The import change in agent
metrics is covered by that run; its skip supplies no finalization evidence.

Documentation freshness was `stale` at task start. `sennel docs build` was
suggested; generated docs are not represented as current by this delivery.

## Final verification and decision

Candidate 9 was captured at `2026-10-10T15:05:37.157Z` with 829 source files
and 793 test files. Collection found no source/test differences from that
capture and no changes during collection.

- Source SHA-256: `19f9e62e75d9ea973fdd26d39c2c19c00966eadf976a735e8f15081f92902d3c`.
- Test SHA-256: `a9f42304dd39d0525bbf5ce06af78c51b5eb905bb15e3b59905671137f0b9df5`.
- Candidate patch SHA-256: `8ee9210b721ee1352dcbd5c6a908b3570a8b18efa9a35d84582a34fb22922fa7`.

| Final candidate command group | Tests | Passed | Failed | Skipped | Log under `.tmp/5ab3/` |
| --- | ---: | ---: | ---: | ---: | --- |
| Real DI and frozen public CLI phase scenarios | 67 | 67 | 0 | 0 | `phase-di-candidate-9.log` |
| Complete structural suite | 972 | 972 | 0 | 0 | `structure-candidate-9.log` |
| Dedicated finalization structure | 88 | 88 | 0 | 0 | `finalization-structure-candidate-9.log` |
| Registered cleanup and Completion atomicity | 12 | 12 | 0 | 0 | `registered-completion-candidate-9.log` |
| Result, acceptance replay and read-only recovery | 113 | 113 | 0 | 0 | `result-replay-recovery-candidate-9.log` |
| Board-listed existing regression record | 42 | 26 | 16 | 0 | `required-regressions-candidate-9.log` |

All six processes exited and their actual exit codes are recorded in
`candidate-9-runs.json`. The regression command exited 1; the other five exited
0. The dedicated structural tests also occur within the complete structure
suite, so these counts are executions, not an aggregate unique-test count.
`final-evidence-candidate-9.json` records complete TAP cases and diagnostics,
candidate histories, immutable baseline comparisons, hashes, commands and
dirty source/test diffs. Its `mandatoryTargetsAllPassed`,
`logsAssociatedWithCandidate` and `sourceMatchesCandidate` are true;
`allCommandsPassed` is false because baseline failures are not converted to
success. `candidate-9-regression-comparison.json` records all 16 matching
case/code/failure types and the single diagnostic-order difference.

The normal managed teardown, all six lost-response checkpoints and exact
owner refusal/restoration now pass within this one complete final run. The
earlier targeted failed run remains a failed run and contributes no combined
acceptance claim. The independent limited review is recorded in
`review-final.md`; no unresolved defect remained in its reviewed boundaries.

Git repositories, refs, index, worktree removal, local bare-origin push,
canonical producers, Version Store, actual registered commands and saved
consumer readbacks were exercised. Worker responses, `gh` remote records and
docs subprocess results/faults were controlled fixtures. Live GitHub PR
publication and a generated documentation rebuild were not performed. This
delivery does not claim external services and Git/Store/deletion form one
atomic transaction, or that the entire repository test suite is green.

For an existing Flow, the four `sennel flow run finalize-commit`,
`finalize-merge`, `finalize-sync` and `finalize-cleanup` entries remain the
public commands, also reachable through the normal dispatcher. Use its saved
next-action for ordinary claim/manual approval and its read-only recovery
advice for the existing exact/interrupted recovery commands. The implementation
introduces no additional configuration or migration step.

Owned diagnostic clone roots were removed only after preserving their witness
files and verifying each Git authority stayed inside its fixture. The four
exact paths, final HEADs and removal results are in `cleanup-inventory.json`;
all are absent. Temporary monitoring files were removed and no owned test or
diagnostic process remains. Producer seeds referenced by retained before/after
harnesses remain reproducibility evidence. Main and other user worktrees were
not modified; the task worktree, branch, audit and acceptance evidence remain
available for review.

Decision: complete for all seven board acceptance conditions. No commit,
merge, push, deployment or board mutation was performed for this implementation.
`delivery.patch` and `delivery.json` provide the complete reviewable delivery,
including this final audit, while retaining the unchanged candidate-9
source/test revisions.
