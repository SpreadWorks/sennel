# Prepare phase test handoff (aae2 → f72f)

## Authority and scope

- Board: `aae2`, phase `01/05`, leaves `branch` and `prepare-spec`.
- Branch: `codex/aae2`; worktree: `/home/nakano/workspace/sennel/.sennel/worktree/aae2`.
- Product baseline and current HEAD: `2ba144ef64c3e3cf02367895e3da91e5a41791d6`.
- Latest board bodies used for the work are preserved in `.tmp/aae2/board-{aae2,fc21,67fd,f72f}.{json,md}`.
- This is the test-first card. Production source is unchanged. Its completion requires a green shared checker and meaningful initial preparation failures; product acceptance belongs to `f72f`.

The normal path starts at public `flow set init`, prepares a disposable Git
repository, reloads canonical storage, obtains the real next action, and starts
the existing Draft through its actual dispatcher, artifact parser, Definition,
Service and Store. External Issue and worker responses are deterministic.
Preparation failure tests inject a fault at an existing persistence, filesystem
or publication boundary; they are identified separately from normal passage.

## Deliverables and reused contracts

| Deliverable | Contract |
| --- | --- |
| `tests/structure/prepare.test.js` | Reuses phase 01 manifest and production registration loading; common A01–A12 checker over both leaves and present official phase exports |
| `tests/integration/flow/prepare-service-boundary-coverage.test.js` | Real production lookup, exact registration identity, original `create`, Service argument/private boundary, real selection and execution in three modes |
| `tests/integration/flow-cli/prepare-artifact-scenario.test.js` | Canonical producer → persistence → manager disposal/reload → real Draft input, refusal and interruption contracts |
| `tests/support/prepare-artifact-scenario.js` | Owned Git fixture and public initialization/preparation; existing repository, commit and cleanup helpers |
| `tests/structure/execution-routing-provenance.test.js` | Common checker regressions: distinct phases and lexical shadows remain legal; targeted lookup/registration-array bypasses and escapes are A11 |
| `tests/support/infrastructure/canonical-step-result.js` | Shared assertions for canonical typed Result readback, reused by Prepare and the existing actual Draft reload scenario |
| `.github/workflows/flow-phase-prepare.yml` | `flow-phase-checker` and genuine failing `flow-phase-contract-red` jobs, evidence upload, no error suppression |

Detailed scope, shared negative references and the named execution shape are in
`prepare-structure-coverage.md`. A phase-specific checker, parallel registry,
Store, internal CLI fake or manufactured completed preparation is not used.

The common checker previously rejected every `executionContract` field in a
module that imported the selected phase's lookup. A single shared source fixture
demonstrates that this also rejects a legitimate consumer of another phase.
The fix reuses existing lookup provenance and declared-caller checking. The same
test fails with the baseline checker and passes with the candidate; its targeted
lookup mutation still fails A11. An unused owner-forwarder/parser extension was
removed before final validation.

The subsequent review found that lookup provenance alone missed consumers of
the selected public registration array. The bounded correction below follows
the already-validated array binding as well; it retains the mixed-phase fix.

## Initial-candidate execution evidence

Every long command writes one raw log before it is inspected. Local Node is
`v22.22.0`. Hashes of the frozen sources, tests and logs are recorded in
`.tmp/aae2/final-candidate.json`.

| Command group | Result | Raw evidence |
| --- | --- | --- |
| Shared checker positive/negative, routing, invariant, manifest and rule suites | 263 tests, 263 pass, 0 fail/skip/cancel; exit 0 | `.tmp/aae2/shared-checker.log` |
| Fixed Draft/Spec/Prepare structure command | 4 tests, 3 pass, 1 initial contract failure, 0 skip/cancel; exit 1 | `.tmp/aae2/phase-structure.log` |
| Historical fixed preparation DI/scenario and Draft/Spec scenario command, first integrated candidate | 60 tests, 21 pass, 39 initial contract failures, 0 skip/cancel; exit 1; all 10 existing Draft/Spec tests pass | `.tmp/aae2/phase-scenarios.log`, `scenario-first-candidate.json` |
| Historical changed Prepare DI/scenario scope | 51 tests (48 scenarios + 3 DI), 10 pass, 41 initial contract failures; exit 1 | `.tmp/aae2/prepare-final.log`, `final-case-results.json` |
| Issue snapshot, worktree binding, required post-worktree hook | 10 tests, 10 pass, 0 fail/skip/cancel; exit 0 | `.tmp/aae2/related-regression.log` |
| Shared mixed-phase regression, identical frozen input | Before: 0 pass/1 fail; after: 1 pass/0 fail; skip 0 | `.tmp/aae2/caller-boundary-{before,local}.log`, `caller-comparison.json` |

Exact board commands:

```sh
node --test tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js
node --test tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js
node --test tests/integration/flow/issue-snapshot-source.test.js tests/integration/flow-cli/worktree-flow-binding.test.js tests/integration/flow-cli/commands/post-worktree-hook.test.js
```

The shared command is the exact file list in the CI checker job. The initial
unchanged shared baseline passed 262 tests and is retained as
`.tmp/aae2/shared-checker-baseline.log`; the final run includes the additional
common regression. Related regression results are reused because the production
files and those three tests have not changed; their input hashes are recorded in
`.tmp/aae2/regression-input-hashes.json`.

After the first integrated run, review corrected P12 to distinguish registry
publication from an authenticated semantic preparation receipt and added P20
for successful nonempty required plugin evidence. P01 additionally checks the
actual worker `executionWorkDir`; receipt expectations read canonical execution
facts without depending on an outer command's return. The historical two-file
Prepare scope was rerun once with:

```sh
node --test tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js
```

The full scenario run measured 73 tests: 28 pass, 45 initial `ERR_ASSERTION`
failures, zero skipped/cancelled/todo; exit 1, 470183.881575 ms. After the
required common-code extraction, only `prepare-artifact-scenario.test.js`
changed. The final affected Prepare scope measured 63 tests: 18 pass, 45 initial
`ERR_ASSERTION` failures, zero skipped/cancelled/todo; exit 1, 110015.298557 ms.
All original 51 case names, outcomes and error codes match the preceding
candidate; the 12 additions have 8 passes and 4 initial reds. All 63 outcomes
and codes match the full run. The ten existing Draft/Spec tests passed in the
full run and are reused, not claimed as freshly run at the latest candidate.
Shared checker (289/289), phase structure (3 pass/1 intended initial failure)
and related regressions (10/10) are hash-verified reused evidence. Initial red
results do not prove execution of assertions behind missing production guards.

The latest affected-scope command, recorded in
`.tmp/aae2/three-fixes-final-prepare.log`, was:

```sh
node --test tests/integration/flow/prepare-execution-observer.test.js tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js
```

It measured 63 cases: 18 pass, 45 `ERR_ASSERTION`, no skip/cancel (53 artifact
cases including nested P21, five DI/caller cases and five helper-validation
cases). The earlier full 73-case run had ten downstream Draft/Spec passes; those
were reused after private-only extraction and are not a current full rerun.

## Requirement results

| Required outcome | Fixed cases / actual measurement |
| --- | --- |
| Both production leaves, common A01–A12, all actual DI | Complete two-leaf manifest passes; absent composition is A01 red; all three DI modes report both missing production registrations; shared positive/negative suite is green |
| Three modes × Issue present/absent through real Draft | All six P01 cases reach actual CLI preparation, canonical creation/Issue/analysis/binding readback and actual Draft worker invocation; each then fails at `savedPreparation(branch)` for the missing branch Result, before shared input and case-specific Issue/path/context/Attempt/dispatch/completed-Draft assertions |
| Result-only Definition, class/registry, receipt facts and consumer delivery | `savedPreparation` fixes exact typed Result restoration, phase Definition selection, source Attempt, one Activity, catalog and authenticated receipt equality; P18 fixes shared Error → Failure with no Connector; details after missing Result/API guards remain unexecuted |
| Safe refusal and no fabricated worker/Attempt | P03 wrong run, P04 dirty branch, P05 unreflected required config, P10 changed mode/OID and P15 owner/base refusal pass; P03 Issue/request incorrectly accepted and P11 mandatory early completion are explicit red |
| Pending caller safe refusal and selection coherence | Display coherence and safe public loader/actual dispatch refusal both pass. Refusal returns `FLOW_TARGET_NOT_FOUND`, starts zero workers and leaves state unchanged. A positive Action is conditional only. |
| Public interruption boundaries and reload | P06 observes owned journal/Git rollback and real retry, then missing semantic Result; P07 inspects the planning checkpoint and saved branch evidence at actual first plugin invocation, then is initially red on missing branch Result. P12 covers authenticated cleanup boundaries; P14 fresh-root/no-journal-identity-reuse passes. P21 nested stale-recovery prefix passes; its child-exit/reload case is initially red at semantic Result. P22's initial red is `publicationFault.commits === 1` observing zero during the real preparation command; stop/reload/retry assertions are unrun. P07 owns actual plugin invocation-order observation. |
| Exact replay and commit/readback behavior | P09 rejects exact replay and is red. Two P13 worktree lost-response/receipt-read-failure representatives are initially red at missing semantic Store path. They require canonical/Git/owner/journal preservation and no fallback/worker. P19 requires real typed receipt recovery arguments before mismatch checks. |
| Required plugin success and failure | P11 required hook refusal passes; P20 reaches actual required hook publication and canonical descriptor/Activity/hash readback, then invokes the actual Draft worker and fails at `savedPreparation` for missing ready Result; shared input and nonempty receipt assertions are unreachable |
| Request fidelity and Action stability | P02 reload/clock digest preservation passes; P17 preserves canonical original request but detects whitespace loss at the actual Draft consumer |
| Existing downstream behavior | Five existing Draft and five Spec cases pass (10 total); Issue/binding/post-worktree regressions pass (10 total) |
| Initial-red branch/CI and handoff | Dedicated branch and two unsuppressed CI jobs added; fixed scope/assertions, revision, per-case results, source/test/log hashes and initial limitations preserved for `f72f` |

The same Store/receipt fault mechanism is centralized in scenario-private
`PreparePublicationFault` for P13/P19/P22: it delegates the original apply/read,
uses `once: true` for P19, captures the actual journal at semantic publication
and Git after commit, invokes the original reader with the actual manager for
replay, and restores idempotently. Case-specific outcomes remain in their
scenarios; no generic framework was introduced. P01/P20 reuse the existing
`assertPreparedDraftInput`; production producer/consumer code remains in use.

The two P13 additions are representative worktree lost-response and receipt
read-failure cases, not a full Cartesian matrix. P21 exits a real child with
code 73 immediately after Git add, confirms stale process identity, and uses a
fresh manager for recovery; this does not claim OS or cross-process transaction
atomicity. P22's intended branch Store commit/reload/retry assertions are
currently unrun: its first assertion observes zero targeted semantic commits.
P13, P21 outer, and P22 remain initial reds at missing semantic Result/Store
contracts; post-guard assertions have not executed. Both A10 caller cases pass.

See `../flow-cli/prepare-artifact-scenario-coverage.md` for the backward causal
producer/storage/readback/consumer map, fake boundaries and exact receipt
serialization contract. An assertion fixed behind a missing-contract guard is
a future acceptance requirement; its successful detailed execution is not
claimed by this initial-red card.

## Revision comparison and limitations

The historical `c731d703` and `51ff765a5` outcomes are not substituted for current
measurements. From `51ff765a5` to this HEAD the compared handoff, dispatcher,
Definition, composition, shared checker and Draft/Spec scenario files differ.
Preparation, SetInit and FlowManager files are unchanged in that comparison.
Current fixed commands exercise the current whole-file handoff implementation.

Structure initial failure is an explicit `ERR_ASSERTION` naming the absent
`src/flow/engine/composition/prepare.js`, rather than an import or syntax error.
Real DI remains initially unavailable because production execution lookup has
neither preparation registration. The assertions after these guards are fixed
future acceptance conditions, not claims of successful execution today.

Static named top-level routes alone do not establish that every enclosing owner
method uses them. Normal preparation therefore has transparent observations of
the original production contract methods; scenario persistence and actual Draft
inputs provide independent runtime evidence. Unsupported static owner shapes
are not declared to force the nested adoption path into an artificial forwarder.

CI YAML was parsed locally and its two jobs and unsuppressed failures checked.
Hosted Actions and Node 18.19 execution have not been run: no push was performed.
The workflow reuses the repository's existing Actions versions and minimum Node
version. No real AI, full-repository acceptance or absent future phase is a
prerequisite for this card.

## f72f acceptance and cleanup

Use these fixed files and commands at one implementation candidate. Implement
production preparation registration, real DI, semantic Result/receipt settlement,
mandatory completion and Draft input delivery; retain the refusal, interruption,
replay and persistence guarantees. All phase contracts and existing Draft/Spec
and related regressions must then be green together. Do not remove guards,
weaken assertions, skip cases or suppress the failing job to achieve green.

`codex/aae2` is the requested dedicated test branch and serves the phase-test
branch role described by `67fd`; the workflow also accepts `flow-phase/01-tests`.
Initial failures remain genuine failures and ordinary test discovery is intact.
The unchanged standard CI continues to discover the new `.test.js` files. The
future acceptance job/branch transition belongs to the implementation card.

Initial test-card judgment was complete. Subsequent review found the two test
support defects recorded below. The initial measurement remains historical
evidence; it is not evidence that those defects were absent. Preparation product
judgment remains not accepted; `f72f` must turn the fixed contract set green.

## Review correction and two-defect fix

The required corrections are limited to two reproduced contract failures:

1. Removing a field-name rejection correctly allowed another phase's execution,
   but also allowed an undeclared caller to select directly from the targeted
   registration array and execute. The common checker now reuses the validated
   lookup/array origins, existing export resolution and lexical binding analysis
   to account for that capability. Pure array forwards, explicit safe lookup
   overrides, other phases and independent lexical bindings remain legal.
2. Canonical `NodeResult.stepResult` is already a concrete `StepResult` instance.
   Passing it to the JSON-only `StepResult.fromStored` decoder throws. The shared
   assertion helper checks the existing typed value and its unique registry
   identity directly. Prepare retains its Definition/receipt/Activity/consumer
   checks, and the same helper executes after real Draft production, persistence
   and manager replacement, before the existing Spec/Acceptance assertions.

No runtime decoder, registry, Store or receipt contract was changed. The earlier
claim that receipt persistence was excessive is withdrawn: the board explicitly
requires durable source/identity/publication evidence. Unexecuted post-guard
assertions remain limitations, rather than newly proven implementation defects.

The draft fix also added metadata projection and mutation parsing. That expansion
was withdrawn after comparing actual supported paths with `fc21`. The source
reader is unchanged. Undeclared collection consumption is unsupported and fails
closed; arbitrary member syntax is not claimed as understood. No additional
owner/caller feature, future preparation product implementation or replay matrix
was added in this correction.

The reduced checker regression file has identical isolated inputs before and
after the fix: **27 tests, 6 pass/21 fail before; 27/27 pass after**, with no skips
or cancellations. The real Draft readback comparison fails at the old decoder
call with `TypeError: stored StepResult fields are invalid`; the final candidate
passes that same producer/reload case. Logs are
`.tmp/aae2/fix-checker-minimal-{before,after}.log`,
`.tmp/aae2/fix-result-before.log` and `.tmp/aae2/fix-phase-scenarios.log`.

Final independent shared-checker execution: **289/289 pass**, exit 0, no skips or
cancellations (`.tmp/aae2/fix-shared-checker.log`). The separate reviewer also
passed eight bounded provenance/restoration cases. Parent phase structure remains
**4 tests, 3 pass/1 expected initial failure**; related regressions are **10/10**.
These shared-checker and provenance results are reused hash-verified evidence,
not fresh runs for the current correction. Their historical input/log hashes
and case comparisons are recorded in `.tmp/aae2/fix-final-candidate.json`.

See the final counts above. The full scenario execution includes ten existing
Draft/Spec cases and all passed there; those ten were not rerun at the latest
Prepare candidate. All 63 Prepare-scope outcomes/codes match the full run, and
the original 51 match the preceding candidate. Related ten regressions are
reused hash-verified evidence, not a fresh rerun for this correction.

No timing speed improvement is claimed. Minimum distinct interaction cases,
shared helper reuse and unchanged-evidence reuse avoid duplicated cost. The
measured initial reds do not establish that assertions behind missing
production guards ran. These measurements do not prove unknown-defect
completeness; missing semantic Prepare contracts and post-guard assertions
remain for the implementation candidate to satisfy.

Owned comparison copies are removed after preserving their hashes and logs.
Fixture roots and process/global mocks are restored by test teardown. Required
raw evidence and this reviewable worktree remain. No commit, merge, push,
deployment, board update or new development Flow was performed.
