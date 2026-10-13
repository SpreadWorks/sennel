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
