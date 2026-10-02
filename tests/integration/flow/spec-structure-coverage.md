# Spec structure implementation verification (99a2)

## Frozen acceptance inspection

Source baseline: `bcc695864` contains the ef49 shared structure checks. The existing
uncommitted ef49 fixture expansion was copied into this isolated worktree before
implementation. Main subsequently committed that identical expansion as
`becea03807997fcd5f9dea5b8666326a7b072693`, which was imported by fast-forward before
continuing implementation. All 42 changed/untracked files were checked byte for
byte across that import; no implementation changes were lost. The original main
working tree was not modified. These four files are part of the
acceptance input, not changes made to suppress implementation failures:

| File | SHA-256 before implementation |
| --- | --- |
| `tests/integration/flow/spec-service-boundary-coverage.test.js` | `a8cbb3839a974a86811be1e3c99672d98241d6dbca52bd327339e38e12d9526d` |
| `tests/structure/AGENTS.md` | `750f428cd77bf9360250625000ed5ad75f49d34d600dda6d74a500ee1a20a56c` |
| `tests/support/infrastructure/spec-gate-repair-scenario.js` | `b05b20797188578886239a99592cb909de31503ea2d080e099b8fcd5b022e535` |
| `tests/support/infrastructure/spec-step-preparation.js` | `8417a97d3a9280b78712f2f4728f4582677458d6255a9e108a8a0010c398a052` |

Initial command:

```sh
node --test tests/structure/spec.test.js tests/structure/draft.test.js tests/integration/flow/spec-service-boundary-coverage.test.js
```

Initial result: 6 tests, 4 pass, 2 fail. Spec production structure and production
A07 cannot load the absent `composition/spec.js`. Draft structure passes; canonical
fixture preparation successfully constructs all six Spec Steps' declared Services.
The missing production registration is an observed acceptance failure. It does not
by itself measure every downstream dependency or Service-state violation.

## Outcome-to-condition verification map

| Required outcome | Necessary conditions and authoritative boundary | Existing verification |
| --- | --- | --- |
| Six registered executable Steps with private Service state | Production registrations declare dependencies; canonical fixture preparation returns actual instances in `PreparedStep.dependencies` | `spec-service-boundary-coverage.test.js`, Spec and Draft structure tests |
| Selected Spec candidate is the published candidate | Sealed worker handoff, exact candidate/baseline/Result identity, Store settlement and durable receipt | `worker-artifact-handoff.test.js`, `spec-step-result.test.js` |
| Review resumes its own execution and publication | Manifest/input digest, binding, claim identity, checkpoint, durable publication and terminal receipt agree after reload | `canonical-flow-manager-runtime.test.js`, `review-work-unit.test.js`, `review-work-unit-input.test.js` |
| Repair preserves meaning and rejects invalid candidates | Same schema validation and four-field finding identity; Step selects candidate once; Service converts and Store verifies publication | `spec-review-worker-result.test.js`, `spec-repair-operations.test.js`, `spec-review-triage.test.js`, `flow-findings.test.js` |
| Gate and task-spec retain settlement and rejection behavior | Current Attempt/publication admission, Step-selected Result, atomic receipt/publication/route | `spec-gate-result-settlement.test.js`, `spec-gate-command-boundary.test.js` |
| Gate repair resumes safely with no duplicate effects | Published response and claim survive reload; stale evidence rejected; selected candidate and receipt remain bound | `spec-gate-repair-replay.test.js`, `spec-gate-repair-restart-boundaries.test.js`, `spec-gate-repair-durability.test.js` |
| Produced Spec is usable downstream | Normal dispatcher generates and saves artifact, reload reconstructs state, downstream consumer actually uses it | `flow-cli/spec-artifact-scenario.test.js` |
| Shared values retain Draft/Task contracts | Single value definition, unchanged digest/JSON representation and snapshot input semantics | Draft structure/scenario, work-unit/revision and Task Review tests |

## Implementation and final results

The same frozen ef49 command now passes all 6 tests: both production structure
closures and A07 across the five Service types and six registrations. No checker,
scope, exclusion, or acceptance expectation was changed.

Internal-API test migrations preserve the asserted outcomes: imports follow the
single moved value definitions; private Service bindings are obtained from the
existing Connector or durable receipt; pure repair operations receive the same
canonical schema through `readSpecJsonValidator()`. Tests inspect the selected
pure candidate's Spec contents before Service publication.

The first value/operation/work-unit/revision/schema run passed 163 of 164 tests.
The failing Gate unit case expected the obsolete repair target `spec`. An isolated
detached worktree at unchanged `becea0380` reproduces the same failure (3 pass,
1 fail in that file). `settleSpecStepResult` and the Spec Gate contract in
`src/flow/AGENTS.md` both route to `spec-gate-repair`; the corresponding integration
scenario uses that route. Only this invalid expectation was corrected. Gate unit
recheck passes all 4 cases. This is a baseline test correction, not a product
behavior change or a weakened structural check.

Two selection-boundary regression cases pass with the implementation. An isolated
copy with the same current tests and source, removing only the new ReviewWorker
Store selection enforcement, fails both with `Missing expected exception
(CurrentFlowStateConflictError)`: changed repair accepts a different Spec candidate,
and triage accepts different Review bytes. This demonstrates actual unsafe
acceptance before the check, not a syntax/import failure. With the check present,
each altered Result, candidate, Review, or baseline is rejected and the tests
verify unchanged canonical state, catalog, and Activity count before allowing the
original selected publication.

```sh
node --test --test-name-pattern='rejects a Review worker settlement|rejects a Triage settlement' tests/integration/flow/worker-artifact-handoff.test.js
```

The independent implementation review identified and verified fixes for Store
selection correspondence, conditional precedence, and reuse of the persisted
Review execution Result/Settlement at publication. Initial Spec facts retain
the original publication/baseline references; their existing Store type checks
now run at the sole production generation boundary before constructing pure facts.

## Executed test commands

All test commands save stdout/stderr once before inspection. Temporary raw logs
and the isolated comparison worktree are removed after the final result is recorded.

```sh
node --test --test-concurrency=2 tests/unit/spec-step-result.test.js tests/unit/spec-gate-step-result.test.js tests/unit/spec-review-worker-result.test.js tests/unit/spec-gate-repair-context.test.js tests/unit/spec-gate-repair-review.test.js tests/unit/spec-gate-repair-context-expansion.test.js tests/unit/flow-findings.test.js tests/unit/spec/schema.test.js tests/integration/flow/spec-repair-operations.test.js tests/integration/flow/review-work-unit.test.js tests/integration/flow/review-work-unit-input.test.js tests/integration/lib/flow-version.test.js tests/integration/lib/load-spec-json.test.js tests/integration/lib/spec-json-requirement-ids.test.js
node --test tests/unit/spec-gate-step-result.test.js
node --test --test-concurrency=2 tests/integration/flow-cli/spec-artifact-scenario.test.js tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow/spec-gate-command-boundary.test.js tests/integration/flow/spec-gate-result-settlement.test.js tests/integration/flow/spec-gate-repair-replay.test.js tests/integration/flow/spec-gate-repair-restart-boundaries.test.js tests/integration/flow/spec-gate-repair-durability.test.js tests/integration/flow/spec-gate-repair-draft-return.test.js tests/integration/flow/spec-review-triage.test.js tests/integration/flow/task-review-checkpoint-recovery.test.js tests/integration/flow/task-review-reconciliation.test.js tests/integration/flow/task-review-publication-binding.test.js
node --test --test-concurrency=2 --test-name-pattern='[Ss]pec|[Rr]eview|[Cc]leanup|handoff.*[Rr]ecover|[Ss]ealed.*[Rr]eplay' tests/integration/flow/canonical-flow-manager-runtime.test.js tests/integration/flow/worker-artifact-handoff.test.js
node --test --test-concurrency=2 tests/integration/flow/spec-gate-repair-replay.test.js tests/integration/flow/commands/review.test.js
node --test tests/structure/spec.test.js tests/structure/draft.test.js
npm run test:agent
```

The final Gate repair replay and Review command run passes 111 tests and includes
the last added exact baseline digest and size check. The final structure run
passes both phase closures. Related unit
and schema checks passed after the documented baseline expectation correction.
The runtime/handoff selection ran 114 cases: 112 passed initially. Two Store-only
fixtures omitted the newly required typed Step selection; they now build that
input from the same canonical Review and Spec, retaining their original receipt,
generation, and revision assertions. Both targeted reruns pass. Production Step
generation is independently covered by the unchanged phase scenarios and handoff
tests, rather than claimed from those Store-only fixtures.

The restart fixture's private-receipt access now uses a canonical receipt read
after reconstructing its FlowManager and before executing the resumed Step. Its
exact completion replay case passes. An initial attempt to capture this receipt
on the discarded manager was corrected without changing assertions.

The Gate advisory integration case also retained the obsolete `spec` repair
target. The original test against restored `becea0380` source fails identically;
its target and corresponding Activity node expectation now use the existing
`spec-gate-repair` route. With that target corrected, unchanged baseline source
also reproduces `failed` rather than the obsolete `invalidated` Gate status.
`repairPlanGate` explicitly preserves a failed Gate while activating its repair
Step. The assertion now checks that existing contract, and the targeted case
passes. This does not change production routing or state transitions.

```sh
node --test --test-name-pattern='records triage and repair review receipts|rebases the merged spec-repair review' tests/integration/flow/canonical-flow-manager-runtime.test.js
node --test --test-name-pattern='rejects a changed publication on exact completion replay' tests/integration/flow/spec-gate-repair-restart-boundaries.test.js
node --test --test-name-pattern='pre-enabled Spec Gate advisory observation' tests/integration/flow/spec-gate-result-settlement.test.js
```

The combined phase/settlement/recovery scenarios ran 103 cases: 101 initially
passed, and the two cases described above pass in targeted reruns. All five
Spec artifact scenarios passed, including persisted downstream use; the Draft
artifact scenario and shared Task Review cases passed.

The required `npm run test:agent` completed with exit 1: 11 cases, 8 pass,
2 fail and 1 opt-in historical skip. The four real worker handoff cases pass,
including canonical Spec publication, triage/repair handoff and Task re-review.
Spec shared quality, Draft structural correction, documentation enrichment and
acceptance quality also pass. The failures are:

- Draft Gate repair: a later Draft coverage repair is rejected for missing
  required targets, before reaching Spec. The Draft completion connector and
  its eligibility check are unchanged.
- Spec repair decision: the real model returned an empty `baseRevision` and
  fails the exact-revision assertion before applying repair operations. The
  prompt, Agent implementation and context serialization logic are unchanged;
  the source value class moved without behavioral edits.

A clean `becea0380` comparison completed: the Draft case also fails for
missing required targets (and additionally reports a stale base revision), at
the same unchanged completion admission boundary. The Spec decision case passes
on that baseline. This supports a pre-existing Draft failure, but does not by
itself prove the Spec model output failure is baseline-reproducible. The moved
`SpecGateRepairSource` class body was compared byte for byte and is identical.
No assertion, repair admission check or provider configuration was relaxed.

```sh
# Isolated unchanged becea0380 worktree:
node --test --test-concurrency=2 tests/agent/draft-gate-repair.test.js tests/agent/spec-gate-repair-decision.test.js
# Current implementation, unchanged test conditions:
node --test tests/agent/spec-gate-repair-decision.test.js
```

The current Spec decision targeted recheck passes both evidence repair and
missing-choice return with no code, assertion or provider changes. This is
consistent with nondeterministic model output, not evidence that all future
responses will succeed. The first full agent run remains recorded as failed;
a targeted rerun does not replace its result.

## Final assessment and cleanup

The 99a2 structural acceptance and scoped deterministic behavior checks are
satisfied, including downstream Spec artifact use and rejection of altered
selected publications. No new regression remains demonstrated in that scope.
The pre-existing real Draft coverage repair failure and the observed one-off
Spec provider response failure remain outside this structural change. The full
agent suite is not reported as green; improving those provider/repair behaviors
would be separate work. The opt-in historical comparison was not enabled, and
the repository-wide default suite was not run.

The imported four acceptance files remain identical to `becea0380` and
`git diff --check` passes. Temporary comparison worktrees and task test logs
were removed. Implementation changes remain uncommitted on
`feature/99a2-spec-structure`; main remains at `becea0380` with a clean worktree.
