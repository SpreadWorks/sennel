# a1ee verification and implementation handoff

This change owns tests and evidence for phase 02. Product implementation belongs
to board `8e30`; an initial assertion red is an expected deliverable, never product
acceptance. The authoritative input is [the frozen board](a1ee-board-source.md).
The source baseline is `main` at `5c8b7f62fa384bc18b52ed05d02b2701164e6c63`,
and the retained review branch is `codex/a1ee`.

## Scope and reuse

The five responsibility leaves are `approval`, `test-generate`, `test-review`,
`test-repair`, and `test-gate`. The tests reuse the phase-02 manifest, shared
A01–A12 checker, production registration lookup, PreparedStep/Service inspectors,
the existing Prepare execution observer, current Result codec/digest and
generation contract, real FlowManager/Store and registered dispatcher, worker
handoff claim/seal, Review work units, RequirementTest values, and local Node Gate.
No product source, dependency, runtime phase, workspace SDD Flow, board state or
review-branch commit is created or changed by this test implementation. Isolated
test repositories and their test Flows are created and removed by fixture teardown.

Only upstream Draft is an immutable fixture. Spec is produced, sealed, reviewed
and gated through the real dispatcher. External workers, Review provider process
responses and the Spec AI provider are deterministic fakes. Canonical candidates,
receipts, evidence, lifecycle decisions and downstream consumers are production
objects. Fault injection wraps real save/read operations; unaffected calls retain
their implementation. Each test discards managers before authoritative readback.

The observer was extended with selectable Step identities and repeated execution
consumption, preserving its existing Prepare defaults and exactly-once assertion.
The pre-existing generation contract only exports its reusable fixture functions;
its assertions and expectations remain unchanged. The new assertion helper uses
real saved Results and publication snapshots, avoiding invented future constructor
names for Approval, Review, repair or Gate.
Review evidence preserves the exact producer publication Activity without requiring
it to equal the later Result Activity; the board fixes that identity, not incidental
co-publication. The Gate checker retains same-Activity validation because Gate
promotion explicitly commits its Result and publication atomically.

## Outcome and caller ledger

The full producer/storage/readback/consumer mapping is in
[the phase causal coverage](../flow-cli/requirement-test-phase-scenario-coverage.md).
The caller ledger below records current source boundaries. Source indexing and an
authored scenario are not proof that a missing production registration has run.

| Caller / responsibility | Existing source / authority | Covering boundary |
| --- | --- | --- |
| Spec → manual approval / dispatcher auto approval | `set-approval.js`, `run-dispatch.js`: CanonicalSpecApproval, approvalRouteFacts, Definition route, approveSpecContinuation | Await, manual/auto, no-R and mixed-R phase cases; approval save/replay cases |
| Approval → Tasks / initial plan / next activation | `canonical-flow-manager-store.js`: TaskCollection admission and initializeRequirementTestLifecycle | Task parent/sibling order, skipped Attempt refusal, approval pre/postcommit |
| Display, claim, mode and retry | `get-next-action.js`, `get-status.js`, `run-claim-next-action.js`, `set-auto.js`, `set-retry.js` | Shared production routing check; real dispatch claims, stable reload, policy switch and retry cases |
| Generation and repair worker admission | `worker-artifact-handoff.js`: input materialization, claim/seal, bounded repair progress, completeRequirementTestLifecycle | Nonfinal generation, batch checkpoints, source identities, stale/seal refusal and commit/cleanup recovery |
| Review command and registry post | `run-review.js`, `registry.js`, `canonical-review-artifacts.js`: CanonicalReviewWorkUnit, promotion and evidence publication | Actual direct command/post DI plus normal sealed Review; PASS/ADVISORY/REJECTED/tooling/permission |
| Gate command and registry post | `run-requirement-test-gate.js`, `registry.js`: local named test observation and Definition lifecycle selection | Direct command/post DI, actual assertion classification, same-candidate rereview and promotion refusal |
| Lifecycle admission and failure entrances | `canonical-flow-manager-store.js`, `run-dispatch.js`, `definition-lifecycle-failure.js`, `test-review-repair.js` | Exact publication binding, retry/external classification, save atomicity, batch and replay refusal |
| Real current implementation entrance | `run-dispatch.js`, source handoff and dynamic Task lifecycle | Reload → actual implement worker input; no future phase-03 Step assumed |
| Test execution and retrospective | `run-test-execute.js`, `run-retro.js`, CanonicalTestArtifactStore | Authored real implementation → promoted-only execution summary → deferred retro |
| Acceptance and report obligations | `run-acceptance-review.js`, canonical Acceptance artifacts, `run-report.js` | Authored real Acceptance read/disposition; unresolved deferred work prevents automatic finalization. Report remains a later consumer, not a fabricated completed phase |

All production registrations are selected from the actual composition and lookup.
The new structure entrypoint applies the shared checker to all present official
phases. Synthetic registrations occur only in a named checker fixture that removes
each of the five leaves independently; they cannot satisfy production or DI tests.
Actual all-five `create()` and typed arguments are observed by the integration
tests once the production composition exists. Any unknown Approval execution
shape must be admitted by the shared A10 shape mechanism in the implementation;
this tests-only change does not create a parallel selector or scope-specific rule.

## Historical source alignment

The scoped comparison of `c731d703` with `51ff765a5` changes only
`worker-artifact-handoff.js` among the RequirementTest lifecycle, store, Review,
Gate and work-unit files (37 insertions / 39 deletions). Its whole-file contract
uses bounded metadata and immutable input references. From `51ff765a5` to the
source baseline, that scoped handoff file has 669 insertions / 122 deletions.
Current `requestInput` reads the real materialized bytes; tests neither inline
those bytes into Step Result evidence nor rely on historical worker prompt fields.
Review manifest/seal, candidate source ownership and Gate named observations are
compared with real current publications. These read-only comparisons establish
source alignment, not before/after verification of a product fix.

## Verification records

The original candidate command summaries, frozen file digests, per-case outcomes,
log digests and separation of checker success, initial product red and masked
later assertions are preserved in `.tmp/a1ee/final-verification.json` and
`.tmp/a1ee/final-cases.json`. They are historical pre-fix evidence, not the final
verification record. Focused follow-up evidence is recorded separately in the
`fix-*` logs and `.tmp/a1ee/fix-verification.json`; the old logs remain unchanged.

Required commands:

```sh
node --test tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js tests/structure/requirement-test.test.js
node --test tests/unit/structured-step-result-contract.test.js tests/integration/flow/requirement-test-service-boundary-coverage.test.js tests/integration/flow-cli/requirement-test-phase-scenario.test.js
node --test tests/unit/requirement-test-definition-policy.test.js tests/integration/flow/requirement-test-lifecycle-regressions.test.js tests/integration/flow/run-requirement-test-gate.test.js tests/integration/flow/mixed-requirement-downstream.test.js
```

The existing required regression command passes 45/45, and shared checker
regressions pass 199/199. Prepare observer integration passes 5/5. Their product
source and relevant tests are unchanged in this candidate, so those completed
results are reused. An additional existing codec run is 14/15: its registry-table
expectation omits already-present Branch/Prepare entries at the untouched source
baseline. That baseline failure was neither hidden nor rewritten.

The final structure command is 6/8 with two explicit assertion reds: missing
RequirementTest composition, and the anonymous Gate loader. The required combined
command ran to completion: 131 cases, 7 pass, 124 fail, no skip or cancellation.
That original log remains unchanged. Its invalid fixture observations are excluded
from product evidence and superseded by corrected targeted results.

The pre-fix candidate contained 133 combined cases. Its historical evidence union
was 11 pass / 122 initial product reds: the original unaffected cases, a corrected
Result/DI run (76 cases, 8 pass / 68 fail), and specifically corrected/new
scenario cases. This union was never a second full 133-case run and is not a
current final count or completion claim. The focused follow-up does not rerun the
full matrix: the 45/45 Store/policy/lifecycle/Gate/mixed regression, 199/199
shared-checker regression, and 5/5 Prepare observer result are reused from the
pre-fix freeze because their tests and relevant dependencies are unchanged. The
focused `fix-parent-regression.log` also passes 1/1 for approved ordered-plan
status across reload and duplicate-claim refusal. Earlier SAV-05 Gate cases in
`final-combined.log` stopped at generation before reaching Gate. SAV-08 and the
six positive Result cases were added in this focused follow-up; their current
runs do not prove Gate atomicity or successful positive Result production.

The focused Gate evidence separates authored contract from reachable production
behavior. SAV-08's before-commit fault is injected after partial physical writes,
before the catalog JSON rename; its after-commit case loses the response after the
whole Store API has committed. `fix-gate-final.log` reports one passing SAV-09
membership/physical-rollback projection and two SAV-08 errors masked at generation,
before the dispatcher reaches `test-gate`. A guard added after imports was not
exercised by that run.
`fix-gate-store-seam.log` has one functional Draft rollback control; its second
Node-reported pass is the unmatched support test file and is not a second rollback
case. `fix-gate-support.log` passes manager reconstruction and immutable support
readback. `fix-gate-ownership-control.log` passes SAV-09 and SAV-10 (2/2); SAV-10
is the API ownership admission check. The downstream ownership contract keeps
`test-gate` as the authorized immutable-support reader, denies that catalog to
implementation, and routes implementation through promoted `tests.source` and
`CanonicalTestArtifactStore`. These controls define the intended ownership and
catalog projection; they do not show a successful production Gate save/reload or
physical rollback through that Gate path.

The six focused positive Result cases are recorded in `fix-result-phase.log`.
Two generation cases reach their real classified adapters and check the retry
budget/new Attempt or blocked/no-promotion outcome before failing on the missing
typed Result. The other four are masked by the earlier generation failure.
`fix-result-oracles-final.log` passes five isolated controls. The separate
`fix-result-default-control.log` passes 1/1 for the default-mode saved-Result
identity projection; these are separate runs, not a combined six-control run.
These results provide controls and failure-prefix evidence, but leave successful positive
Result production, persistence, readback and downstream use unmeasured. The
follow-up therefore distinguishes code-backed test-contract coverage from
unmeasured product behavior; it does not claim that either product gap is fixed.

The Gate savepoint contract does not require a Cartesian product of every leaf
with every fault class. Shared Store and policy rules remain covered by the
existing lower-layer tests; phase-specific scenarios add only the producer-to-
consumer joins needed where a distinct leaf changes the contract.

Fixture corrections use source-backed public contracts: typed Review evidence
resolution; canonical Task admission rather than Spec array order; `in_progress`
for the active approved R; catalog absence at approval rather than an unauthorized
plan consumer; the typed canonical Spec writer for publication races; and a genuine
Spec Gate semantic cycle-limit stop before nonblocking policy activation. The
earlier file-read exhaustion experiment is excluded because it supplies no accepted
semantic facts. These corrections do not relax any board expectation.

| Board acceptance slice | Test implementation | Measured product result / limit |
| --- | --- | --- |
| Shared A01–A12 scope, five actual registrations, DI and named routing | Fixed in shared scope and real preparation tests | Missing composition/registrations and anonymous Gate loader are explicit reds; actual five-Service preparation remains unmeasured |
| Closed Results, single registry, saved-only Settlement and Connector boundaries | Fixed in Result/codec tests and saved-result scenario assertions | Typed operands, leaf Results and Settlement API are missing; canonical evidence checker controls pass |
| Approval/Await, ordered Tasks, no-R implementation | Fixed through real dispatcher, approval and current implement | Await replay, Task order and implement input exercised; missing typed approval Result and skipped Attempt sequence 1 remain reds |
| Approval atomicity and stale publication | Fixed with real journal precommit fault and typed same-byte Spec republishing | Task admission remains after interrupted approval; stale approval accepts a different Activity; both are measured reds |
| Candidate generation, Review, repair batches and Gate promotion | Fixed through real workers, seals, Review work units, local Gate and publication readback | Normal generation fails on source Attempt; structural repair continuation does not advance the second semantic count; SAV-08 Gate atomicity remains masked; SAV-09 membership/rollback projections, SAV-10 ownership controls and post-reconstruction support readback pass |
| Semantic/tooling budgets, reload, policy, permission and replay | Fixed in phase and existing decision/store tests | Existing isolated rules pass; status/duplicate claim and unsupported policy activation refusal pass; valid upstream nonblocking reaches Requirement repair and preserves budget/state before missing typed Result red |
| Commit/receipt/cleanup recovery and exact batch/coordinator identity | Fixed at real public save/read/fault boundaries | Seal-tamper refusal and one Draft physical-rollback control pass; SAV-08 Gate savepoint pair is masked at generation, so Gate rollback and successful Gate publication remain unmeasured |
| Mixed promoted/deferred exit and downstream obligations | Fixed through current implement, test-execute, retro and Acceptance consumers | Authored downstream consumers are masked by generation; promoted-only execution and deferred Acceptance obligations are not claimed as measured |

The a1ee deliverable is the completed tests-first contract and its evidence.
Product acceptance remains unmet and belongs to `8e30`. Neither the written test
matrix nor its expected initial reds proves that the product routes already work.

## Acceptance limits and next step

Documentation freshness was stale at work start; a docs build was recommended.
Source remains authoritative and no docs regeneration is part of this tests-only
scope. No real external AI, repository-wide tests, OS-crash or cross-process
recovery guarantee is claimed.

Observed production defects and unexecuted downstream guarantees are handed
to `8e30` in the retained tests and per-case records. Normal valid sealed generation currently fails with
`Requirement test source Attempt must be an object`. A structural rejection can
reach repair, but normal repair preparation then fails because staged sources are
missing. Missing typed Results/registrations and invented no-R skip Attempts are
separate initial reds. Interrupted approval leaves an admitted Task Activity, and
same-byte new Spec publication is accepted by approval. Fixing these belongs to product implementation; rerun the
unchanged frozen inputs and expectations there. A masked assertion is not a
verified atomicity, budget, promotion, stale-admission or downstream guarantee.

The worktree is retained for review. No commit, merge, push, publish, deployment,
board mutation or Flow start is authorized or performed by this implementation.
