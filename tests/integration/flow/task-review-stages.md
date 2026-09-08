# Task review stage causal coverage

The contracts below start from externally observable outcomes. Fixtures must use
the production Task lifecycle, Review protocol, parent source observation, and
catalog publication paths. Provider execution is the fake boundary in deterministic
tests. Persisted results are read through a newly constructed manager.

| Outcome | Necessary condition and consumer | Legal producer and durable evidence | Coverage |
| --- | --- | --- | --- |
| Only repair changes source | Review/triage source integrity; repair has exact apply set and Task allow-list | Review protocol and source handoff parent; review/triage/repair histories and mutation lineage | `task-review-stages.test.js`, `review-protocol.test.js`, `review-work-unit.test.js` |
| Rejected findings remain traceable | Triage and repair bind original finding identity, requirement, Task, revision, and producer Attempt | `TaskReviewStageInputs` and canonical source confirmation; separate catalog histories | `task-review-stages.test.js`, `review-recurrence.test.js` |
| All-reject proceeds without rewriting review | Every original finding has one reasoned non-application decision | Definition stage connector and persisted triage; repair skip | `task-review-stages.test.js` |
| All-reject reaches Acceptance as rejected review evidence | The committed all-reject triage Activity, source Review, dispositions and rationale bind one current Task round | `TaskReviewConvergenceEvidence` rebuilds the projection from task review/triage histories and the exact stage-completion Activity; Acceptance prompt consumes it without calling it no-change or unreviewed repair | `task-review-stages.test.js`, `review-recurrence.test.js` |
| Unknown, missing, duplicate or foreign findings are refused | Exact triage coverage and exact repair apply set | Shared triage and repair boundary contracts; no publication on rejection | `worker-artifact-handoff.test.js`, `task-review-stages.test.js` |
| Mutation attribution is complete | Every apply finding and actual mutation are covered; paths stay within Task lineage; HEAD/index unchanged | Parent baseline, manifest, finding mutation bindings | `worker-artifact-handoff.test.js`, `task-review-stages.test.js`, `task-source-handoff-recovery.test.js` |
| Budgets survive reload without double consumption | Review result count only advances on publication; Task rounds, repair Attempts and Gate attempts are distinct | Canonical histories, Task implementation budget, Definition stage plan | `task-review-stage-transition.test.js`, `task-review-round-exhaustion.test.js`, `task-review-stages.test.js` |
| Recurring repairs use exact previous evidence | Current apply findings match prior repaired fingerprints in the same cycle and round; exact resolution coverage | Immutable recurrence input rebuilt from canonical review, triage, and repair histories; shared repair validator | `task-review-stages.test.js`, `review-recurrence.test.js` |
| Empty-source completion is advisory and explained | Empty allow-list, reason, matching source/review, explicit Definition continue selection, Acceptance record | No-change continuation selection stored in the same canonical Activity transaction as its producer artifact and skip connector | `task-review-no-change-continuation.test.js`, `task-review-stages.test.js`, `task-review-round-exhaustion.test.js` |
| An interrupted overrun restores the exact Gate frontier | The pre-repair journal identifies both ordinary and stage-started Gate Attempts; Task triage/repair may be done or skipped | Canonical Activity replay restores all five leaf results/statuses while retaining Attempt sequence counters | `canonical-flow-manager-runtime.test.js` skipped/completed two-round variants |
| Crash/reload never adopts unverified edits | Parent-owned persisted baseline, sealed handoff, current source matching exact observed manifest | Cataloged baseline and source publication transaction | `task-source-handoff-recovery.test.js` |
| Consumers accept only a confirmed producer result | Catalog descriptor, producer Attempt, Activity and Task-stage binding agree; ordinary draft confirmation remains valid | Typed Task-step identity selects stage confirmation only for Task review/triage/repair; all other producers use their established confirmation contract | `producer-artifact-readiness.test.js` |
| Exhausted Task repair failures stop at repair | Three semantic repair failures persist across reload; Gate stays pending and direct retry/settlement is refused without mutation | Definition-owned bounded retry-and-block policy retains the failed repair Attempt as the terminal frontier | `task-source-handoff-recovery.test.js` |
| All entrypoints enforce the same authority | Latest Definition, active Attempt, target guards and exclusive worker authority | Dispatcher/direct command/recovery using canonical producer | `set-step.test.js`, `worker-artifact-handoff.test.js`, `task-review-stages.test.js` |
| Old three-leaf state is untouched and refused | Stored structure matches the active Definition before any mutation | Definition/Version admission, without read-time migration | `current-flow-state-foundation.test.js` |

A draft reopen retires prior no-change continuations from both the user-facing
assurance projection and Acceptance evidence; the production reopen scenario is
in `task-review-no-change-continuation.test.js`. A failed or replaced Attempt
cannot publish stage success or fail its successor; these publication and race
boundaries are exercised in `task-review-stages.test.js`.

Normal-source all-reject is different from the no-change continuation: the
current Task-round projection retains the original `REJECTED` review and every
reasoned reject disposition for Acceptance. Historical all-reject evidence does
not become current Acceptance authority after a later implementation round.

The Task repair failure boundary is also compared in an isolated source copy
with only its Definition policy changed from bounded retry-and-block to the
ordinary retry policy. The live policy remains blocked after the third semantic
failure; the isolated ordinary-retry copy records the failed producer and exposes
the next Gate route, proving the stop condition is the policy rather than an
incidental missing-artifact rejection.

The table is a coverage index, not a claim that every listed scenario has passed.
Completion requires the corresponding executed results and the required full
`npm test` and `npm run test:agent` runs.


Existing scenario corrections preserve the production contracts: Task fixtures
now publish Review before entering triage/repair, and shared Flow repair fixtures
publish their requirement-to-file map from the legal implementation producer.
The context-read metric test now expects normal metric publication in managed
workers, matching the existing registry behavior and the canonical observation
rule permitting validated `record_metric` Activities. Recovery drift cases expect
one terminal failure Activity while retaining source edits and all producer
artifacts; equality of the entire pre-failure state would conceal that required
failure record.


The Task Gate repair regression uses the same final fixture and assertions in an
isolated source copy with only the `done`/`skipped` admission fix removed. It fails
at the skipped triage guard before the fix and passes with the fix, proving the
second implementation round remains reachable after a PASS Review and exhausted
Gate. The copy contains no repository Git metadata or live Flow state.
