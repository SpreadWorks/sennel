# Requirement Test phase causal coverage

Source: main `5c8b7f62fa384bc18b52ed05d02b2701164e6c63`; board a1ee.
This is a tests-first phase contract, not a product implementation or completion claim.

The observable outcomes below are traced backward through the production producer,
publication, readback and consumer. `RequirementTestPhaseScenario` only seeds the
upstream Draft. Spec is produced via the registered dispatcher and sealed worker,
reviewed through the real Review work unit, and gated. No Requirement candidate,
review evidence, lifecycle decision, receipt or promotion is supplied by a fixture.
The local Gate actually runs Node tests. External worker and Review subprocess
responses and the Spec AI provider are deterministic fakes.

| Outcome | Required condition and legal producer | Authority / readback | Consumer / test |
| --- | --- | --- | --- |
| No unauthorized execution | Unapproved Spec; dispatcher selects Await; manual approval alone grants requested authorization | Approval Result/receipt/Activity, Spec `user_approval`; discard manager before replay | Approval dispatch; `keeps unapproved Await` |
| No-R implementation | Manual SetApproval or auto dispatcher approval; no testable Requirement; TaskCollection parent-first stable sibling order | Spec, runtime Tasks, approval receipt and four skipped leaves without Attempts | Actual implement worker input; two `no testable R` cases |
| Approved R reaches implementation | Manual/auto approval initializes ordered plan; nonfinal generation retains same Attempt; normal sealed candidate; PASS/ADVISORY Review; matching Gate assertion | Plan publication, candidate source/bundle and lineage, Review evidence, Gate history, promoted `tests.source`; discard manager at staged and promoted boundaries | Actual implement input; two mixed/multiple-R cases |
| Repair keeps one source episode | Sealed generation structural rejection or canonical Review REJECTED; canonical bounded batch planner; all batches finish before next revision | Review full finding identities, repair progress/staged sources/receipts, source Attempt, predecessor revision; reload after first batch | Real repair worker then Review/Gate; `multiple repair batches` plus structural cases |
| No false promotion | Assigned ownership and bootstrap checks precede publication; Gate runs one named assertion and matches Spec expectation | Candidate remains isolated; Gate mismatch leaves same revision and zero semantic delta | Structural handoff and real Gate; ReferenceError, syntax, import, skip, missing, multiple and cross-R cases; correct fail/pass in mixed case |
| Semantic limit remains per R | Repeated real structural rejection and bounded repair worker responses; manual/auto each capped at five | Plan Budget, repair source episode, failure/deferred receipt; discard manager each retry | Next pending R then implement; two `caps each R at five` cases |
| Nonblocking cannot bypass Requirement repair | External semantic Spec Gate observation → actual bounded repair and repeated observation until cycle-limit strict stop → public policy activation and recorded continue decision → approval → structural rejection | Canonical Spec Gate publication/decision, persisted policy, unchanged Requirement budget on policy replay | `retains upstream Spec Gate nonblocking policy`; independent `refuses unsupported nonblocking activation` checks direct test-repair activation rejection and canonical state preservation |
| R budget survives restart | Real Review rejection charges one R; public SetAuto changes policy; reload retains counters | Plan Budget and semantic finding identity | Repair continuation; `per-R semantic consumption` |
| Tooling exhaustion does not contaminate promoted R | Actual Review sealed tooling observations consume only active R; up to three retries, then deferred receipt | Plan, tooling finding, failure/deferred publication; manager discarded each retry | Next frontier and canonical Acceptance context; `tooling exhaustion` |
| Permission does not retry | Actual Review sealed permission observation | External-blocked failure; zero budget; replay leaves state/provider calls unchanged | Next-action blocked and dispatch replay; `external permission` |
| Mixed deferred obligation survives downstream | Promoted-only test source selection; current implement/Task source workers and real Task Review protocol precede actual test-execute, test-result-review, retro and Acceptance commands | `tests.source`, test execution/history, deferred receipts/findings, retro, Acceptance evidence; reload at each consumer | `tooling exhaustion` case calls `consumeMixedDownstream`; external provider declares deferred R notVerifiable and leaves its exact source finding still open |
| Atomic/recoverable publication | Production fault injectors at real persistence and worker handoff boundaries | Version Store, Activity, receipt, canonical reload | Root-owned `requirement-test-save-recovery.contract.js`, imported by phase test |

## Focused test-contract corrections

The follow-up closes two gaps in the **test contract**. Gate publication now
checks physical rollback and exact catalog membership around two distinct
boundaries: before the catalog JSON rename, after partial physical writes; and
after the whole Store API commits, when its response is lost. In both cases,
primary and shared support artifacts must move with the same Gate Result, plan,
receipt and Activity. The contract uses the existing catalog and Store; it adds
no support-baseline schema. `test-gate` is the authorized reader of immutable
support bytes, while implementation cannot read that support catalog and consumes
promoted `tests.source` through the actual downstream `CanonicalTestArtifactStore`
path.

This Gate path is still unmeasured in the normal phase scenario. The two SAV-08
cases in `fix-gate-final.log` stop at the earlier generation error
(`Requirement test source Attempt must be an object`) before reaching `test-gate`.
SAV-09 membership and physical-rollback projections pass. Actual API ownership
admission is SAV-10; `fix-gate-ownership-control.log` passes SAV-09 and SAV-10
(2/2). `fix-gate-support.log` passes manager reconstruction and support-byte
readback. `fix-gate-store-seam.log` contains one meaningful Draft rollback
control; Node also counts an unmatched support file as a passing file-level
subtest, so this is one functional rollback result, not two. The final focused
Gate log has one SAV-09 pass and two SAV-08 cases masked at generation. Its tiny
guard inserted after imports was not covered by that run. Thus the authored Gate
atomicity contract is precise, while successful production Gate promotion and
rollback remain unmeasured.

The positive Result contract adds six production-path cases: Review's saved
execution-required checkpoint must precede provider output, then the saved-only
execution decision proceeds through PASS and Gate; generation and repair
tooling/external outcomes enter through their classified adapters; and Gate
tooling records the real runner's exit code 2. These do not manufacture a
pre-Step/provider failure. In `fix-result-phase.log`, the two generation cases
reach their adapters and verify retry budget/new Attempt or blocked/no-promotion
before stopping at the missing typed Result assertion. The other four cases are
masked by the earlier generation error. The five controls in
`fix-result-oracles-final.log` pass, but they do not establish the full positive
producer→save→readback→consumer path. Production positive Result behavior remains
unmeasured until that path can complete.

The focused `fix-parent-regression.log` scenario passes the approved ordered-plan
status read across reload and confirms a duplicate claim cannot create another
Attempt. This adds the phase-specific connection to the existing Store/policy
rules without repeating their broader decision matrix.

Primary isolated rules remain in `requirement-test-definition-policy.test.js`,
`requirement-test-lifecycle-regressions.test.js`, `run-requirement-test-gate.test.js`,
`mixed-requirement-downstream.test.js`, and the result/structure/DI suites. They cover
semantic 5/manual and auto, tooling 3, duplicate finding identity, nonblocking,
ownership, replay and stale matrices without copying the same matrix into every layer.
Their fixture shortcuts do **not** establish the production phase causal links.

## Initial measured limits

Normal dispatcher generation currently returns
`FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED` with
`Requirement test source Attempt must be an object` after receiving a valid sealed
candidate. This is an explicit assertion failure on the normal producer route,
not an import/syntax failure, fabricated authority, or impossible state. No product
code is changed to bypass it. Dependent Review, repair, Gate, budget, mixed exit and
Acceptance assertions are written but are **not exercised** until this producer
contract is implemented/fixed. The dedicated Step/Result/Service registrations
also remain missing; saved Result assertions intentionally expose that separately
where the preceding real path can run.

Actual post-implementation `test-execute`, `retro` and Acceptance consumption are
now authored in `consumeMixedDownstream`. The helper continues through the current
normal implement and dynamic Task lifecycle with external source-worker responses;
the external Task Review process calls the real provider protocol, parser and seal.
The dispatcher alone activates later consumers. No arbitrary downstream activation,
fixture completion or receipt import is used. These guarantees remain **unmeasured**
until the earlier normal generation publication succeeds; their authored status is
separate from execution/acceptance status.

Manual/auto semantic five are authored through real structural rejections, allowing
that legal alternate producer to reach repair independently of the ordinary
generation codec failure. Nonblocking activation at test-repair is unsupported by
the public API and is tested as a safe refusal. A separate scenario activates it
through actual Spec Gate semantic repair exhaustion and preserves the policy into
Requirement repair. Duplicate finding replay remains covered by
isolated decision/store tests and the recovery contract, not claimed as a separately
measured phase loop. Response-loss/stale publication coverage belongs to the
root-owned recovery contract and its execution log.

The upstream nonblocking scenario uses the existing Spec scenario's semantic
observation and cycle-limit path, with real bounded Spec repair workers. It requires
the saved `spec-gate-blocked` Result and `cycle-limit` reason before calling policy
activation. An earlier file-evaluation experiment is excluded from product-failure
evidence: repeated `evaluationUnavailable` legally exhausts the response protocol
before accepted semantic facts exist and does not authorize nonblocking activation.
Its log is retained as `scenario-nonblocking-invalid-file-premise.log`.

The corrected single-case run (`scenario-nonblocking-supplemental.log`) reaches
four real Spec Gate cycles, saves the cycle-limit Result, activates policy through
the public API, records continue, reloads, approves, and reaches Requirement repair
through structural rejection. Policy replay preserves state, Activity, catalog and
the consumed manual semantic budget of one; no Requirement source is promoted.
Only the final missing `test-generate-structural-rejected` typed Result assertion
fails. These preceding policy/Requirement interactions are measured, unlike the
downstream guarantees masked by the normal generation failure.

Initial reachable observations: unapproved Await replay leaves canonical state and
external calls unchanged, but has no `approval-awaiting-user` typed Result. Both
manual and auto no-R approval reach the actual implement worker input, but skipped
Requirement leaves have Attempt sequence 1, violating the board's no-invented-Attempt
contract. Static import and wrong ownership structural rejection reach repair and
retain candidate isolation, but no typed `test-generate-structural-rejected` Result
is saved. These are assertions on production behavior, not new implementation.
