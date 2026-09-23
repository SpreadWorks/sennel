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
| Draft: same-ID findings remain distinct | The production dispatcher runs Draft, registered Reviews and two Gate Attempts. The final Gate result has two observations with the same guardrail ID and different fingerprints; both are carried forward | The actual Spec worker handoff contains both source observations; Acceptance reads both exact saved sources | Gate publication, `flow.findings`, Draft StepResult and settlement receipt are saved; a new manager reloads them before the consumers read them | `draft-artifact-scenario.test.js`: “produces Draft through registered Review/Gate commands and reloads its exact findings for Spec and Acceptance” |
| Draft: safe carry-forward and refusal | An unresolved finding follows the legal Draft Gate repair/carry-forward path; stale admission or invalid repair is rejected | Spec is selected only after the Draft repair and coverage route completes; external Spec authentication failure leaves Spec unpublished | Reload confirms the terminal StepResult, route, artifact catalog and unchanged state on refusal | `draft-artifact-scenario.test.js` plus focused `draft-gate-terminal-continuation.test.js` cases |
| Spec: created and reviewed artifact reaches consumers | Production Spec worker output passes Review, Triage, Repair and a new Gate evaluation; the repaired revision is re-reviewed | Test reads the requirement; Acceptance reads the Spec and builds evidence; Approval saves approval and advances the Flow | Spec revisions, review publications, Gate history, StepResults and receipts are persisted; a new `FlowManager` reads the Spec before Test, Acceptance and Approval use it | `spec-artifact-scenario.test.js`: “publishes and repairs Spec, then reloads it for Approval, Test and Acceptance” |
| Spec: deferred Gate finding reaches Acceptance after explicit continuation | Strict stop is durable, nonblocking policy is activated, and a recorded decision authorizes continuation | Acceptance reads the exact unresolved Spec Gate source and reports its disposition | Reloaded Gate source, findings and continuation state are read by the Acceptance artifact store | `spec-artifact-scenario.test.js`: “retains unresolved Spec Gate findings for Acceptance after a durable strict stop” |

## Focused refusal and recovery coverage

- Draft Gate terminal and repair boundaries: `draft-gate-terminal-continuation.test.js`.
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

- Draft and Spec phase scenarios: 3/3 passed together after sharing the external
  Gate provider fixture. The Draft scenario uses the production dispatcher.
- Spec normal production scenario passed: Spec creation, Review/Triage/Repair,
  Gate retry, reload, Test/Acceptance reads and Approval.
- Spec deferred-finding scenario passed after fixing producer readiness for an
  explicitly accepted nonblocking continuation. Its failed Gate Attempt remains
  the exact source of the deferred finding after the settlement Attempt.
- The final Draft scenario passed with current source lookup and failed with
  `FLOW_FINDING_SOURCE_MISSING` in an isolated copy where only the old
  same-ID-first source lookup was restored.
- `npm test` passed 882 unit, 43 E2E and 6 Acceptance tests. Integration passed
  3603/3609; the six failures were reproduced with the same assertions on the
  unchanged HEAD in a detached comparison worktree. They belong to the CLI
  dispatch, missing-producer recovery and set-retry suites, not this diff.
- Post-cleanup focused artifact-contract, Acceptance source, producer-readiness
  and finding tests passed 47/47.
- Focused refusal and recovery tests listed above remain the separate evidence
  for their respective boundaries; the phase scenarios do not replace them.
