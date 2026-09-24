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

## Verification status

### Current implementation verification (2026-09-24)

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
