# 37a3 Draft contract completion verification

Board source: `.tmp/37a3/board-source.md` (retrieved before implementation).
Base: `main` at `66f318c9e688e7cd545ed018b3808d25782de613`.
Branch: `codex/37a3`; worktree: `.sennel/worktree/37a3`.
Measurements: 2026-10-12–13, Node.js v22.22.0. The original implementation and
measurements did not mutate the board or activate a development Flow. Commit
and main integration were subsequently authorized by the user; the recorded
base identifies the original measurements.

## Implementation contracts

- The ten existing Draft Steps, concrete Result registry, StepRegistration,
  Service preparation, Definition settlements, and canonical Store remain the
  execution path. No new execution framework or duplicate state authority was
  introduced.
- Draft Review preparation refusal uses the existing fatal admission failure
  adapter. A committed publication checkpoint is preserved; no terminal Error,
  fallback failure, or retry consumption is fabricated.
- Conditional Draft producer refusal authenticates the worker with the existing
  exact canonical execution claim. A legitimate rebound/correction invocation
  does not have to equal the enclosing dispatch invocation.
- Shared persistence failure classification and exact receipt recovery moved
  into `step-persistence-failure.js`. Services import that module directly; the
  existing lifecycle failure facade exports the same implementation. Class,
  original IO exception, and no-fallback classification identity are preserved.
- `recover-draft-execution --reason` explicitly authorizes replacement of a
  saved Draft Step Error Attempt. The current exact failure receipt is checked
  before and during commit. Old Error history, Step identity, retry consumption,
  and operation claims are preserved. Recovery authorization and replacement
  are committed together. Automatic retry remains blocked, and stale or repeated
  recovery is refused.
- Recovery receipt serialization is required only for the new recovery operation.
  Existing Activity shapes are unchanged. `ActivityTransition.fieldsFor()` is
  shared by construction and stored-data validation.
- The existing Attempt owner resolver was generalized to `canonicalAttemptOwner()`.
  Explicit recovery follows its exact failed predecessor; ordinary retry and
  typed target connection retain their existing producer contracts. Gate repair
  keeps its original Gate authorization while binding execution to the current
  repair Attempt. Reopened Draft workers retain the original reason, Issue
  provenance, previous Draft and answered questions.

## Acceptance evidence

The table maps the required outcomes to their producers, persistence boundaries
and actual consumers. All listed acceptance runs completed with zero failures.

| Requirement/outcome | Producer, storage and actual consumer | Evidence/result |
| --- | --- | --- |
| Ten Step/Result contracts and dependency injection | Production registration → constructed Step/Service; concrete Result registry → stored Result restoration | Result/Factory contracts: 9 pass; Draft Result factories: 6 pass; Definition/receipt contracts: 6 pass. Dynamic all-Step Service inspection passes in the 20-case consumer/admission batch. |
| Prepare → actual Draft entry | Real CLI preparation in branch/worktree/no-branch modes, with/without Issue → saved prepare receipt → actual Draft worker input | `prepare-draft-boundary.log`: P01 × 6 and P08, 7 pass. |
| Draft generation, Review, Branch/Loop, Gate and Spec/Acceptance input | Registered dispatcher/commands, canonical publications → discarded/reloaded managers → real later consumer | `draft-integrated.log`: 66 pass. After the final lineage/context changes, `final-draft-production.log`: 29 pass, including the Draft production scenario, dispatch authority, terminal connection and Draft/Spec structure checks. |
| Question Await, answer reuse and repair changed/unchanged | Normal Draft question ledger and worker handoff → receipts/QA/audits → reload → actual Step/next Action | The 11 selected QA/repair cases pass in `draft-consumer-admission.log`. Cases that start from a fixture Candidate or directly selected Result do not independently prove initial AI question generation. |
| Invalid Review refusal with no false success or extra failure | Raw invalid Review payload → publication checkpoint → rejected terminal preparation → fresh manager readback | `review-failure-boundaries-r4.log`: 11 pass. The original empty-payload assertion is retained; Attempt, consumption, receipt, catalog and Draft preservation are checked. |
| Direct execution admission and stale refusal | Canonical Definition selection → direct Gate/Review admission → zero provider/state effects on refusal | Store/Connector stale cases pass in the integrated batch; direct Review three cases and direct Gate two cases pass in `draft-consumer-admission.log`. |
| Coverage PASS does not rewrite Draft | Review observation → selected completion connector → exact Draft/catalog readback → Gate | Integrated cases check preserved bytes/descriptor and the production Review connection separately. |
| Protocol correction, upper limit and distinct refusal evidence | Claimed worker invocation → canonical rejection checkpoint → readback → next correction or safe refusal | Focused correction and durability runs pass. The final full `draft-checkpoint-restart.test.js` run, `final-checkpoint-restart.log`: 14 pass, zero failures or skips; includes the original three failures and retained-claim interruption/recovery. |
| Gate Step Error → explicit recovery → same Gate execution | External provider context-limit response → registered Gate Error/Failure receipt → blocked → registry recovery → reload → actual Gate PASS/Spec entry | `draft-step-error-recovery-boundaries.log`: 3 pass, including concurrent canonical-change refusal and publication interruption rollback. |
| Gate repair recovery retains authorization and targets current Attempt | Accepted repair integrity Error persisted through the normal committer → recovery → exact original owner and new target → fresh worker/claim → publication → real Coverage read/PASS | `draft-repair-error-lineage-final.log`: 1 pass. Source Error evidence absence is also refused. |
| Reopened Draft recovery preserves context and QA | Normal Spec Gate repair Draft return → normal handoff preparation and explicit Error persistence → recovery → new request → real Draft validation/publication → Review selection | `reopen-error-context-after-r3.log`: 1 pass; `reopen-spec-correction-consumer.log`: 1 pass for the independent legitimate prior-answer correction route. |
| Other replacement binding families | Refine reads existing ledger/new Await; Review creates fresh work unit; review-repair binds original producer to new target | Three representative cases pass in `replacement-refine-r3.log`, `replacement-review-r4.log` and `replacement-review-repair.log`. These explicitly exercise Error persistence APIs; they do not claim each factory automatically emitted the initial Error. |
| Persistence uncertainty, atomicity and shared consumers | Existing Store transaction/receipt recovery → original Error classification and source evidence → reload | Integrated Result/Gate rollback and replay cases pass. Shared lineage and Spec bounded repair: 8 pass. `spec-shared-consumer.log`: one production Spec/Approval/Test/Acceptance scenario passes. |
| Standalone import and dependency responsibility | Cold module loading without CLI pre-import/host initialization; real phase structure inspection | DraftService and recovery module cold imports pass in both import orders. Draft and Spec structure checks pass in the final 29-case production batch without special CLI pre-import. |
| Actual agent regression | Real agent CLI → phase-specific worker artifacts → actual publication/consumer | `npm run test:agent`, `agent-regression.log`: 14 tests, 13 pass, zero failures, one unchanged opt-in historical regression skipped. |

The 20-case consumer/admission batch also checks explicit Draft context omissions,
Issue priority over a concurrent request, and refusal when the materialized project
overview changes before publication. These supplement the preparation input proof;
they are not silently included in the seven Prepare case assertions.

The primary agent directly reviewed the production diff, source/API boundaries
and final logs. A separate read-only subagent review found no additional concrete
defect after the lineage/context corrections. The final production run and the
required `npm run test:agent`, followed by the full checkpoint/restart file, all
exited successfully. Counts from overlapping batches are not added together as
a unique test total. `.tmp/37a3/candidate.json` records the branch, base HEAD and
SHA-256 of the 32 changed source/test JavaScript files; no source or test code
in that manifest changed through the subsequent code audit. Main integration
validation is recorded separately below.

## Test corrections and regression attribution

Two pre-existing failures were test/API mismatches, not missing product features:

- `StepRegistration.create()` preserves its synchronous and asynchronous
  preparation contract. Invalid synchronous arguments use `assert.throws()`;
  an invalid asynchronous preparation retains `assert.rejects()`. The three
  original invalid argument inputs remain rejected.
- The fixed registry expectation includes the already introduced Finalization
  Results and Error registrations. Abstractness, uniqueness, fixed kind/type/Step,
  and invalid restoration checks are preserved; valid registrations are not removed.

Original same-input refusal/correction failures were recorded at the unchanged base
before product edits. Reopened Draft context loss was detected by the same new
test before its reader fix. For the two repair recovery defects, each product fix
was independently removed in a code snapshot while retaining the same test input
and assertions. Missing continuation recognition fails at the exact owner lookup;
restoring the old target fails at current Attempt equality. Import errors and
invalid fixture assertions are not counted as behavioral regression detection.

The final two comparison snapshots run with a Git discovery ceiling and contain no
Git metadata. Snapshot `git rev-parse` exits 128. `lineage-isolation-result.json`
records unchanged live HEAD, staged diff, owned sources and canonical files. The
first comparison without a ceiling is not the final isolation evidence.

## Usage and limits

After correcting the cause of a persisted Draft Step Error, inspect the guarded
current Flow target and invoke:

```sh
sennel flow run recover-draft-execution --reason "Describe the corrected cause and re-execution decision" --expect-binding <current-binding>
```

The command records operator authorization and starts a replacement Attempt for
the same Step. It does not execute the worker. Continue the normal guarded
dispatcher afterwards. `--reason` records the operator's correction statement;
the CLI does not independently prove that the provider or underlying cause was fixed.
The existing exact legacy conditional checkpoint recovery remains supported.

The deterministic phase suites fake external provider/process responses while
exercising internal consumers and canonical persistence. Separately, the actual
agent suite ran real agent CLIs and passed 13 cases. These checks verify logical
restart, transaction and admission boundaries; they do not simulate an OS crash.
Step execution JSON isolation and old worker termination remain outside 37a3.
No full suite is required by this board; affected common consumers are selected.
The initial documentation freshness check reported `stale`; rebuilding generated
docs was proposed but is outside this implementation. Source and measured results
are authoritative for the acceptance assessment.

Logs are local `.tmp/37a3/` evidence. Retain final acceptance and baseline/fault
logs. Disposable comparison snapshots and 22 superseded or invalid intermediate
logs/readbacks were removed; `.tmp/37a3/cleanup.json` records the latter. All owned
test runs finished. The implementation worktree is retained for review and evidence.

## Final assessment

Complete within board 37a3. The required normal, branch/loop, Await, refusal,
failure, explicit recovery, persistence/readback and later-consumer outcomes are
covered above. The new operator recovery records its authorization rather than
proving the underlying correction. External OS-crash behavior, the opt-in
historical agent comparison and the explicitly separate 4cca/process-termination
work are not claimed as verified acceptance outcomes.

## Main integration validation

Main advanced to `948c8a6cc8a21a7c5d2e8e1fe6a485e821e425f4` after the original
measurements. Its Flow query revision introduced a detail producer inventory
that did not recognize the new `recover_draft_step_error` Activity. The existing
non-detail operation inventory now includes the shared recovery operation
constant; it does not fabricate evaluations, findings or repairs.

An added case in `query-details.test.js` uses the production settlement API to
save a Draft Gate Error, reload, authorize recovery, reload again and query the
actual recovery Activity. It checks not-applicable detail coverage and unchanged
canonical state, Activity ledger and catalog. This is a saved Error boundary,
not a claim that this case automatically produces the initial Gate Error.

The same input and assertions fail before the inventory fix with
`DETAIL_UNAVAILABLE` / unsupported producer. After the fix, all 25 query-detail
cases pass with zero failures or skips (`merge-query-details-after.log`); the
failure evidence is retained in `merge-query-recovery-before.log`.

The merged-main Draft production scenario and all three provider-produced Error
recovery cases also pass (`merge-draft-verification.log`: 4 pass, zero failures
or skips). They cover downstream Spec/Acceptance consumption, same-Gate
re-execution, refusal after concurrent canonical changes and atomic rollback on
interrupted recovery publication. These runs are limited integration checks;
the full repository and real-agent suites were not rerun for this integration.


## Follow-up alignment at f6c763ee (2026-10-14)

This section supersedes the earlier completion assessment for the refined board
captured in `.tmp/37a3/board-source.md`. The implementation base is
`f6c763ee3115d93ace6f675fa4d4e4dfe9538abb`; branch `codex/37a3` and the existing
`.sennel/worktree/37a3` are retained. No development Flow was started. This
follow-up does not commit, merge, push, or change the board.

### Decisions and scope

- Draft Questions/Coverage and Spec Review share their existing typed Result
  factories through dedicated pure modules. All callers use those modules;
  the former Step modules have no compatibility re-exports.
- Definition selects new execution, sealed replay, publication replay, or safe
  stop from read-only handoff observations. `get-next-action`, direct execution,
  and dispatch use that selection. Existing Step Error recovery, question Await,
  semantic correction and bounded transport retry keep their existing owners.
- Only a newly committed Store claim supplies first-start permission. Exact
  claim replay returns `newlyClaimed: false`. Selection identity includes the
  execution receipt and response digest, so the same Attempt cannot reuse an
  earlier generation's selection.
- An already claimed operation with no exact saved response stops without a
  new provider, failure Result, Attempt, generation, or budget reset. An exact
  sealed/publication response is processed through the existing handoff checks
  without another provider call. A current-operation transport retry carries
  the previous typed execution contract; it cannot be reconstructed merely by
  restarting dispatch. Malformed submission transport errors retain the existing
  one-retry contract only after exact previous-contract validation.
- Fixture preparation now uses the real Review/Gate command and external
  provider fakes. A Review checkpoint interruption occurs at the real Store claim
  boundary, after all production manifest inputs have been declared. Rollback
  snapshots are taken after legitimate claims and before publication.
- The broader Query consumer checks exposed an existing Draft Gate gap: generic
  execution-contract-only Activities were unknown to Query. Query now uses
  `readExecutionContractFromView(..., { current: false })` with captured bytes,
  selected Flow/Step/Task and exact selected artifact-path checks. Only a lone
  execution contract with no semantic references, Result or Review publication
  is execution-only. Mixed publications retain their existing projection.
  Unknown fields, foreign Flow/Attempt/generation and semantic references fail
  closed. No current runtime or filesystem read is introduced into projection.

### Refined acceptance mapping

Counts below describe individual batches, not an additive unique-test total.
Every log is under `.tmp/37a3/` unless an absolute baseline path is given.

| Board condition | Producer → storage/readback → actual consumer | Evidence |
| --- | --- | --- |
| 1. Pure factories and structure | Shared typed factories → existing Result codecs → Step and Query | `query-factory-route-unit.log` (13 pass); `structure-policy-final.log` (7 policy + 2 structure pass). |
| 2. First execution exactly once | Real checkpoint/claim → Store `newlyClaimed` → conditional provider | `claim-new-replay-final.log` (1 pass), plus normal production and restart scenarios below. Exact replay retains receipt/state/ledger and has no new permission. |
| 3. Retained claim safely stops | Interrupted real claim → new manager → next-action, direct worker execution and restarted dispatcher | `phase-restart-final.log`; `assertRetainedClaimStops` checks zero provider/dispatch calls and unchanged canonical state, Activity, catalog, receipt, Draft bytes and consumption. |
| 4. Legal checkpoint/sealed/publication continuation | Real external output → canonical lifecycle → reload → shared selection → registered Step | `continuation-replay-r1.log` (4 pass); `query-questions-frozen-final.log` (1 pass); successful Coverage and Gate/Spec cases in `query-producer-final-r2.log`. |
| 5. Publication interruption | Fault before/after real publication → preserved publication → restarted terminal consumer | Sealed/publication Gate repair cases in `continuation-replay-r1.log`; Query checkpoint/publication/terminal scenarios prove shared retained entities without provider re-execution. |
| 6. Exact refusal | Old selection, foreign contract, changed retained body or binding → readback → refusal | `stale-selection-fault-comparison/`; `query-generic-claim-final-r2.log` (16 pass); original Query binding checks in `query-integration-final.log`; `worker-consumers-final.log` (14 pass). |
| 7. Resolve the original 17 | Product/factory boundary, restart policy, proper fixture producer, fixed catalog/registry inventories | `draft-contract-final.log` (89 pass) and the restart/structure logs. Attribution below preserves the original failure categories. |
| 8. Existing behavior | Question/repair producer, handoff validator, recovery producer → persistence → later Review/Gate | `review-authority-repair-final.log` (17 pass), `worker-consumers-final.log` (14 pass), `review-failure-boundaries-current.log` (5 pass), and provider-produced Error recovery in `draft-contract-final.log`. |
| 9. Ten-Step ownership and atomicity | Existing composition, Service and Store → exact settlement/replay → completion connector | `draft-contract-final.log`, `structure-policy-final.log`, and the mandatory Draft/Spec phase scenarios in `phase-restart-final.log`. |

`draft-malformed-submission-targeted.log` additionally proves that an ordinary
read of malformed saved output is blocked and read-only, while its live bounded
retry calls the provider twice total, publishes the repaired Draft, and passes
that revision through real Coverage Review to Draft Gate.

### Failure attribution and regression detection

The unchanged-base measurement recorded 126 selected tests: 109 passed and 17
failed. The baseline logs are `/tmp/sennel-37a3-current-triage-*-bootstrap.log`.
Those failures were classified before changing assertions:

- One Query import failure was a production dependency boundary violation.
- Two restart expectations conflicted with the retained execution claim contract.
  The same production interruption now verifies the required stop across all
  three consumers, including unchanged evidence and no additional provider call.
- Twelve fixture failures lacked the production execution contract/claim and
  therefore never reached their intended rollback, terminal, or stale boundary.
  External provider fakes now let the real producers establish those prerequisites.
- One refusal expectation incorrectly treated a legitimate execution contract as
  a forbidden catalog mutation. It now checks that exact retained contract and
  separately refuses terminal artifacts, Result/failure fabrication and retries.
- One registry expectation omitted the already registered
  `AcceptanceReviewExecutionHeldResult`. Uniqueness and invalid restoration
  remain checked.

Additional integration findings were corrected without weakening the existing
consumer assertions: Query checkpoint fixtures omitted execution-option inputs;
Spec Review retained its required manifest import after the factory extraction;
and the generic Draft Gate claim needed the strict Query projection above.

Fault comparisons use gitless copies of source/tests/package only, with
`GIT_CEILING_DIRECTORIES` preventing parent-repository discovery (`git rev-parse`
exits 128). No live canonical state or original worktree source is modified.
`claim-observation-fault.json` and its log record that removing only the shared
admission observation changes the expected `blocked` directive into
`execute_step`. `stale-selection-fault-comparison/` records identical tests with
and without the receipt/response/constructor identity check: the omitted check
accepts an old selection and fails `assert.rejects`; the restored check passes.
`malformed-fault-evidence.json` records the same final live-retry test with
only the authorized transport-error handling removed: dispatch stops after one
call with `FLOW_ARTIFACT_HANDOFF_INVALID`; the fixed path passes and reaches
Coverage Review. The frozen test hash, fault patch and git-isolation refusal
are retained. All three disposable comparison snapshots were removed.
These demonstrate known-contract regression detection, not exhaustive proof
against unknown faults.

One intermediate Query run (`query-producer-final-r2.log`) observed different
snapshot IDs while source files were still being edited. Its Coverage and
Gate/Spec cases passed. The Questions case retained the same assertions and
passed after source freeze (`query-questions-frozen-final.log`); the intermediate
failure is not counted as a product fix or a passing case. Invalid diagnostic
assertions from development runs are likewise not regression evidence.

### Remaining validation record

The mandatory Draft/Spec production and checkpoint/restart batch completed with
**30 passed, 0 failed, 0 skipped** (`phase-restart-final.log`). This includes
normal downstream consumption, quotation/evidence preservation, Draft reopen,
sealed/publication recovery, retained-claim stop, stale checkpoint refusal,
legacy recovery, correction bounds, and seven Spec production variants. The
subsequent malformed-submission case passed separately. The independent
read-only cross-review found no actionable defect in
execution-only Query classification, mixed-publication fallback, historical exact
binding, captured-byte reads, or authorized transport retry. It did not rerun
broad suites. The shared selection's earlier stale-generation finding and the
malformed-submission retry finding have executable regression comparisons.

`npm run test:agent` completed with **12 passed, 1 failed, 1 existing opt-in
historical test skipped** (`agent-regression-current.log`). The real question
reviewer additionally proposed dropping unresolved retention question `q5`; its
assertion correctly failed. The prompt builder/parser, direct Agent/provider
path, test and Draft input builder are byte-identical to the implementation base
(`agent-quality-failure-attribution.json`). This is an observed unresolved model
quality failure on an unchanged path, not a demonstrated baseline reproduction
or a claim of deterministic provider stability. No expected value was weakened
and no repeated provider run was used to obtain a pass. This additional suite is
not an acceptance requirement of the refined board; its failure remains an
explicit limitation of the wider validation.
The full repository suite is outside the board's required validation. Documentation
freshness was `stale`; a generated docs rebuild was proposed, and source plus
measured execution remains authoritative. No external dependencies, host-specific
callbacks, alternate state authority or lost-response recovery were introduced.


### Follow-up final assessment

The refined board's nine acceptance conditions are satisfied. The original
17 selected failures are resolved through the production, fixture and inventory
changes described above. No new unconditional retry or false completion is
introduced. The additional real-provider question-quality failure remains
unresolved and is explicitly excluded from any all-tests-passed claim.

`current-candidate.json` records the base, branch and SHA-256 hashes of all 24
changed/new JavaScript files. The final hash comparison found no drift after
source freeze. `git diff --check` passes. The main checkout, other worktrees,
existing canonical Flow state and original baseline evidence were not changed.
All owned test commands have ended. Temporary fault-comparison copies were
removed; patches, hashes, isolation proof and outcome logs remain for review.
The branch and worktree are retained, with changes uncommitted.
