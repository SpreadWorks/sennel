# Draft and Spec phase-owned scenario coverage (board 6065)

Each producer phase owns a production scenario that checks its persisted
artifact at the downstream use boundary. The Draft scenario reaches only the
Draft artifact's Spec and Acceptance consumers. The Spec scenario starts from
valid upstream state and covers Spec creation through its Test, Acceptance and
Approval consumers. Focused tests continue to own independent decisions,
refusal paths and recovery boundaries; the phase scenarios verify their
connections without replaying the entire Flow.

| Phase and result | Necessary condition | Downstream use | Durable boundary and readback | Covering scenario |
| --- | --- | --- | --- | --- |
| Draft: same-ID findings remain distinct | The production dispatcher runs Draft, registered Reviews and two Gate Attempts. The final Gate result has two observations with the same guardrail ID and different fingerprints; both are carried forward | A new `FlowManager` and dispatcher read and construct the real Spec worker handoff; the Acceptance artifact store resolves both exact saved sources | Draft, Review, Gate and `flow.findings` artifacts are read after reload and their descriptor hashes/byte lengths are checked. Draft Review/Gate StepResults and settlement receipt bindings identify the producing attempt and target | `draft-artifact-scenario.test.js`: “produces Draft through registered Review/Gate commands and reloads its exact findings for Spec and Acceptance” |
| Draft: safe carry-forward and refusal | An unresolved finding follows the legal Draft Gate repair/carry-forward path; stale admission or invalid repair is rejected | Spec is selected only after the Draft repair and coverage route completes; Spec authentication failure leaves Spec unpublished on both initial dispatch and dispatcher restart | The restarted dispatcher issues only a new Spec request. Its metric and issue-log publication add exactly two Activities; the prior ledger prefix, semantic state, retry budget, Draft/Gate/findings descriptors and bytes remain unchanged | `draft-artifact-scenario.test.js`; `draft-gate-terminal-continuation.test.js`: “rejects stale Draft Gate admission without persisting an Error Result”, “rejects invalid repair payload without changing Draft state or artifacts”, and “persists no-progress repair completion and defers the recurring draft Gate finding to Spec” |
| Draft: changed Gate repair survives reload | The dispatcher saves a changed `draft-gate-repair` result and selects Coverage Review; the saved Draft revision names that repair as producer | The registered Review command materializes the repaired Draft into its sealed work unit and records its exact source revision; the registered Gate evaluator reads the repaired Draft; the Spec worker handoff receives those same bytes | A new `FlowManager` reads the repaired Draft before dispatch. Review input bytes, manifest digest and source revision, Gate provider input, Spec handoff digest and document, and the final Draft descriptor are checked against that saved revision | `draft-dispatch-authority.test.js`: “continues a fixture-prepared boundary from Store readback and hands the exact canonical Draft to Spec” |
| Spec: created and reviewed artifact reaches consumers | Production Spec worker output passes Review, Triage, Repair and a new Gate evaluation; the repaired revision is re-reviewed | Test reads the requirement; Acceptance reads the Spec and builds evidence; Approval saves approval and advances the Flow | Spec revisions, review publications, Gate history, StepResults and receipts are persisted; a new `FlowManager` reads the Spec before Test, Acceptance and Approval use it | `spec-artifact-scenario.test.js`: “publishes and repairs Spec, then reloads it for Approval, Test and Acceptance” |
| Spec: deferred Gate finding reaches Acceptance after explicit continuation | Strict stop is durable, nonblocking policy is activated, and a recorded decision authorizes continuation | Acceptance reads the exact unresolved Spec Gate source and reports its disposition | Reloaded Gate source, findings and continuation state are read by the Acceptance artifact store | `spec-artifact-scenario.test.js`: “retains unresolved Spec Gate findings for Acceptance after a durable strict stop” |

## Focused refusal and recovery coverage

- Draft Gate stale admission, repair rejection, atomic settlement, carry-forward,
  and retry exhaustion: `draft-gate-terminal-continuation.test.js` (tests named
  in the Draft row above; “rolls back Gate evidence, issue source, Result, and
  repair route when settlement is interrupted”; “settles the fifth draft Gate
  failure after four completed repair and coverage cycles”).
- Draft review source authority when producer Activity is missing, disallowed,
  or not the confirming publication: `canonical-draft-review-source.test.js`:
  “fails closed when descriptor Activity is missing, disallowed, or not the
  producer confirmation”.
- Draft repair handoff rejects unauthorized/malformed operations and stale
  revision/evidence: `draft-gate-repair-handoff.test.js`: “rejects malformed or
  unauthorized batches without partial draft, audit, or outcome publication”,
  “rejects a sealed request after the canonical draft revision changes”, and
  “rejects a sealed request after its exact source issue evidence changes”.
- Draft settlement rollback, stale Attempt and exact replay: `draft-step-result-settlement.test.js`:
  “rolls back Result, receipt, Activity, artifact, and target when publication is
  interrupted”, “replays an identical settlement without duplication and rejects
  a changed Result”, “rejects an explicitly stale Attempt binding before any
  settlement effect”, and “replays the exact artifact publication and rejects
  changed artifact bytes”.
- Spec Gate stale, mismatched and invalid command authority: `spec-gate-command-boundary.test.js`.
- Spec Gate atomic settlement and exact replay: `spec-gate-result-settlement.test.js`.
- Worker handoff selected-candidate, stale binding, interrupted commit and
  recovery: `worker-artifact-handoff.test.js`.
- Acceptance's recorded source path and exact finding identity:
  `run-acceptance-review-source.test.js`, `flow-findings.test.js`, and
  `flow-artifact-contract.test.js`.
- Nonblocking eligibility, explicit decision, stale activation and dispatcher
  behavior: `nonblocking.test.js`.

## Draft producer to consumer boundary

The durable `draft` artifact can be written by `draft`,
`draft-questions-repair`, `draft-refine`, `draft-coverage-repair`, and
`draft-gate-repair`. Review, Gate and Spec consume the current catalog
publication. The Review source revision identifies its writer, digest and
byte length; Gate and Spec receive the corresponding document.

| Producer route | Save and readback evidence | Consumer connection and remaining boundary |
| --- | --- | --- |
| Initial `draft` | `draft-artifact-scenario.test.js` dispatches the worker and reloads its cataloged Draft | Registered Questions and Coverage Reviews, Gate, Spec handoff and Acceptance finding source are exercised. The same-ID/different-fingerprint pair remains distinct after reload. |
| `draft-questions-repair` | `draft-review-repair-handoff.test.js` covers changed and unchanged handoff publication and reconstructs `CanonicalDraftReviewSource` after reload | The focused test checks the source projection selected for Review. It does not run the Review command or later Gate and Spec consumers for this changed branch. |
| `draft-refine` | `draft-dispatch-authority.test.js` covers worker-free settlement and handoff authority; `worker-handoff-full-flow.test.js` covers recovered Refine publication | The production Draft scenario runs this step without a Draft change. A changed Refine revision is not followed through every downstream consumer here. |
| `draft-coverage-repair` | `worker-handoff-full-flow.test.js` saves a changed revision, reloads it, and also covers unchanged repair | This producer has a focused repair connection; the phase scenario does not enter a changed Coverage repair branch. |
| `draft-gate-repair` | `draft-dispatch-authority.test.js` saves a changed repair and reconstructs its manager; `draft-artifact-scenario.test.js` retains the unchanged/no-progress branch | The changed revision is checked at Review input and source revision, Gate evaluation, and Spec handoff. Focused Gate tests retain rejection and replay ownership. |

## Responsibility check

- Draft and Spec Steps adopt typed facts as Results. Their services use the
  shared settlement API and selected Definition connectors to persist the
  Result, publication and route.
- `RunDispatchCommand`, `GetNextActionCommand`, and registered command hooks
  own action admission and execution. Phase scenarios use those production
  paths while faking external agent/provider responses and process output.
- Spec worker, Acceptance and artifact-view consumers resolve findings through
  `CanonicalFlowFindingsStore` and `FlowFindingSourceIdentity`. Acceptance
  reads a recorded catalog path; an active producer retains its
  producer-authorized read.

## Spec Gate advisory outcome coverage (board 7c2e)

The plan Spec Gate stop does not require a decision to retain strict policy.
Advisory activation is explicit; it neither makes a failed Gate pass nor resets
the repair budget. Task-spec retains its separate external-input contract.

| Observable outcome | Necessary condition and producer | Storage and readback | Consumer and verification |
| --- | --- | --- | --- |
| Strict stop without confirmation or reevaluation | Registered Spec workers and Gate evaluations exhaust the plan repair cycle; the Step saves its blocked Result | Result, receipt, Attempt, Gate history and policy survive a new manager | `spec-artifact-scenario.test.js`: status, next-action and restarted dispatcher must retain the stop and strict policy |
| Exhausted repair is rejected atomically | Explicit policy activation reads that same saved Result; Definition excludes repair | A stale/direct repair request leaves Attempt, catalog and Activity unchanged | `spec-artifact-scenario.test.js` and `spec-gate-result-settlement.test.js`: rejection before mutation, then explicit continue |
| Admitted advisory repair changes the Spec before reevaluation | A below-limit semantic Gate Await Result permits repair; the existing plan repair producer binds the blocking observations to the source Gate | Decision and repair record commit together; the normal Spec handoff saves a changed Spec and repair outcome | `spec-artifact-scenario.test.js`: restarted dispatcher consumes the repair record, runs Spec and its downstream chain, then evaluates the new Gate input |
| Legitimate Await publication remains readable after repair | Earlier plan repair record and outcome precede a new Gate evaluation; normal settlement publishes its Await Result | Exact receipt binding and digest, catalog descriptor, publication Activity and Attempt agree | `spec-artifact-scenario.test.js`, `spec-gate-result-settlement.test.js` and `canonical-gate-observation-cycle.test.js`: status and next-action consume the same persisted proof |
| Invalid publication is refused | Receipt is absent or changed, Attempt differs, or catalog and Activity disagree | Malformed boundary input is isolated from real Flow state | Focused publication tests own rejection of each independently required identity; the phase scenario owns production and readback |
| Non-retryable post failure stops with a concrete reason | The post hook fails without a current authenticated settlement authorizing replay | Failure and earlier Gate evidence remain unchanged after manager reconstruction | `spec-gate-post-failure.test.js`: stable blocked with missing conditions, no unsupported repair command or worker execution |
| Unresolved FAIL reaches Acceptance | An explicit evidence-bound continue follows a strict stop | Gate FAIL remains in history and its exact finding source is published for disposition | `spec-artifact-scenario.test.js`: the real Acceptance artifact store reads retained findings after reload |

The two known faults are compared with identical tests against the unchanged
pre-fix source in an isolated checkout: unnecessary strict confirmation and
rejection of a legitimate Spec settlement publication. These comparisons do
not prove coverage of unknown faults. No running Flow is advanced or modified
to verify these outcomes.

## Verification status

### Board 7c2e verification (2026-09-24)

- Source baseline: `b8b3f5955`, plus the board 7c2e working-tree changes.
  The unchanged baseline fails the same strict-stop test with
  `await_user_decision` instead of `blocked`, and the same post-repair Await
  publication test with `canonical post-repair Gate result requires one exact
  publication Activity`. Both contracts pass with the implementation changes.
- Focused receipt/publication unit tests passed 14/14, Step Result tests 4/4,
  persisted Spec settlement tests 11/11, and post-hook failure tests 2/2.
  Nonblocking policy and next-action regressions passed 69/69.
- Final Spec production scenarios passed 3/3, including an explicitly enabled
  advisory repair, durable Await readback, repair-record reload, changed Spec
  publication, another Gate evaluation, and downstream artifact consumption.
- The related regression invocation ran 249 tests: 245 passed and four
  `gate-transition-boundary.test.js` cases failed. Three exposed an undefined
  variable in the generic Gate eligibility path; one caught unnecessary new
  serialized fields in the Task Gate contract. These are implementation
  regressions, not baseline failures; the generic Gate changes were removed.
  Draft's production scenario and all 125 canonical runtime cases passed in
  this invocation. After removing the generic Gate additions, the unchanged
  Gate boundary tests passed 31/31 and Spec Step Result tests passed 4/4.
  No repeat of the entire related invocation or full `npm test` was performed.
- The existing Flow's 56 evidence files are unchanged by SHA-256 comparison.
  Historical comparisons used an isolated detached worktree. No actual Flow
  was resumed. Temporary test logs are removed after verification; measured
  results and the fault-to-test mapping are retained here.

### Previous implementation verification (2026-09-24)

- HEAD `66e39a9f9` plus the uncommitted refinement changes. Draft phase 1/1
  and Spec phase 2/2 passed; both also ran in the default integration suite.
- Questions/Coverage changed/unchanged connections passed 4/4;
  Draft provider refusal/restart passed 1/1. Gate publication recovery passed
  applied/no-progress 2/2 and Store/atomic boundaries 5/5. Exact receipt and
  same-bytes/different-Activity refusal checks passed.
- Default run: unit 879 pass / 1 failed file; integration 3622 pass / 11 fail;
  E2E 43/43; Acceptance 6/6. The unit import cycle was fixed (affected file
  3/3). Additional integration failures were corrected and rechecked:
  publication authority group 4/4, outcome refusal 1 case, full-flow 1 case,
  Refine file 10/10. Six failures match the isolated pre-change baseline.
  This does not turn the initial full invocation into a green run.
- Real-agent initial run: 4 pass / 3 fail / 1 existing opt-in skip. Corrected
  Gate and Draft worker routes passed individually; Task repair/re-review
  also passed on the diagnostic run with matching source and mutation evidence.
  The first Task failure's artifacts were not retained, so its cause is unknown.
- Full-suite log: `/tmp/sennel-refine-full.log`. Focused follow-ups:
  `/tmp/sennel-gate-publication-fault-final.log`,
  `/tmp/sennel-gate-full-failures-corrected-r2.log` (outcome case only),
  `/tmp/sennel-full-flow-draft-target.log`,
  `/tmp/sennel-draft-question-ledger-refine-classification.log`.
  Detailed evidence/limitations: `.tmp/draft-spec-quality-verification.md`.
- Final follow-ups changed tests only; no repeat full invocation was performed.
  `git diff --check` passed.

### Historical snapshot

- The verification counts below are the recorded board 6065 snapshot; they do
  not include later scenario changes unless a newer result is recorded here.
- Draft and Spec phase scenarios: 3/3 passed together in that snapshot after
  sharing the external Gate provider fixture. The Draft scenario uses the
  production dispatcher.
- Spec normal production scenario passed: Spec creation, Review/Triage/Repair,
  Gate retry, reload, Test/Acceptance reads and Approval.
- Spec deferred-finding scenario passed after fixing producer readiness for an
  explicitly accepted nonblocking continuation. Its failed Gate Attempt remains
  the exact source of the deferred finding after the settlement Attempt.
- Historical source-identity isolation evidence is tracked separately from the
  phase scenario. A passing scenario alone does not prove the historical
  same-ID lookup regression; its isolated pre-fix comparison must retain the
  same input and assertions.
- `npm test` passed 882 unit, 43 E2E and 6 Acceptance tests. Integration passed
  3603/3609; the six failures were reproduced with the same assertions on the
  unchanged HEAD in a detached comparison worktree. They belong to the CLI
  dispatch, missing-producer recovery and set-retry suites, not this diff.
- Post-cleanup focused artifact-contract, Acceptance source, producer-readiness
  and finding tests passed 47/47.
- Focused refusal and recovery tests listed above remain the separate evidence
  for their respective boundaries; the phase scenarios do not replace them.

## Draft scope boundaries

- This production scenario covers Draft worker creation, registered Reviews
  that return PASS, an unchanged Draft Gate repair, Coverage Review, Gate
  carry-forward, Spec handoff refusal/retry, and Acceptance's
  `CanonicalAcceptanceArtifactStore.deferredFindings` read. It does not run the
  complete Acceptance workflow.
- It does not run a changed Draft Questions or Coverage triage/repair through
  the full dispatcher. The component connection is covered by
  `draft-review-repair-handoff.test.js` for changed/unchanged variants; it does
  not substitute for dispatcher-specific admission or recovery checks.
  The lower-level worker handoff contract is also covered by
  `canonical-flow-manager-runtime.test.js`: “hands cataloged draft review
  payloads to V1 triage and repair without exposing attempts wrappers”. That
  test does not prove the end-to-end dispatcher connection for those paths.
- The provider refusal in the phase scenario occurs at Spec after Draft has
  completed. Draft worker refusal/restart is covered separately by
  `draft-dispatch-authority.test.js`, with classification checks in
  `definition-lifecycle-failure.test.js` and `commands/review.test.js`.

## c825 measured verification (2026-09-27)

Baseline: `a76c4fb457c174f5e8a9ce8b6db71310194013e4`, with the c825
uncommitted product and test changes. Independent review and the managing
agent's diff/result inspection found no blocking issue. No live Flow was
started or resumed for verification.

| Test selection | Observed result |
| --- | --- |
| `draft-repair-operations.test.js` and `draft-gate-repair-handoff.test.js` | 33 passed, including authority, stale input/evidence, atomic rejection, replay, obsolete field refusal, and observed target digests. |
| `draft-artifact-scenario.test.js` and `draft-dispatch-authority.test.js` | Initial run: 11 passed and 2 fixture failures. Removing the retired Gate field and using the actual Review source revision API resolved both; targeted rerun: 2 passed. The unchanged primary phase scenario passed. The final consumer observation assertions were rerun separately: 1 passed. |
| `draft-gate-terminal-continuation.test.js` and `draft-review-repair-handoff.test.js` | Initial run: 11 passed and 1 failure from the retired field in the shared fixture. After updating the fixture, that case passed. |
| Draft-named cases in `canonical-flow-manager-runtime.test.js` and `draft-completion-connector.test.js` | 32 passed. |

The assertions were not relaxed to resolve fixture failures. Consumer inputs
are captured at the external provider/worker boundary and compared after
dispatch, before status/count assertions, so provider error handling cannot
hide the actual mismatch behind a retry or terminal code.

The fixed multiple-array-element test was copied unchanged into an isolated
baseline checkout: it failed with `FLOW_DRAFT_GATE_REPAIR_INVALID` under the
old required-digest contract and passed with the product fix. This demonstrates
the new contract; it does not reclassify the old invalid payload's correct
rejection as a defect or claim an exact historical worker replay.

| Isolated fault injection | Observed failing assertion |
| --- | --- |
| Record the containing array's digest instead of each element's digest | Multiple-element test rejects `acceptedOperations` observed digests. |
| Change only the repaired validation text back to the old text when materializing Review input, preserving other bytes | Readback scenario rejects Review input bytes versus saved Draft bytes. |
| Change the Draft validation text to the old text in the Gate evaluator input | Readback scenario rejects the evaluated `## Content` document versus saved Draft. |
| Serialize the old validation text into the Spec request's Draft document | Readback scenario rejects the actual Spec request document versus saved Draft, before retry/request-count assertions. |

Each mutation was applied separately to a disposable repository with independent
Git metadata; the live product and canonical Flow evidence were not mutated.
Syntax/import errors and unrelated terminal failures were not accepted as
mutation evidence. Raw logs and disposable copies were removed after inspection;
this section retains the measured outcomes.

These measurements do not cover every producer/consumer combination listed
above, OS-crash behavior, the full repository suite, or stochastic live-agent
success. The normal deterministic scenarios cover the changed Gate contract
and its real downstream consumers; the other repair contracts are unchanged.
Unknown-defect completeness is not claimed.

Frozen final test SHA-256, `tests/integration/flow/draft-repair-operations.test.js`: `c935714c6786a0430ff920d68c161566aa3293af36fa1c55b5839f4e8cbaddf6`.

Frozen final test SHA-256, `tests/integration/flow-cli/draft-dispatch-authority.test.js`: `c43d2b54f7b9067e7f64c2b755ac914686b687cbcbee3d9012c45587bd32883a`.
