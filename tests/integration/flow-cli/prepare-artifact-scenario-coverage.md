# Prepare → Draft artifact scenario contract

Source baseline: `2ba144ef64c3e3cf02367895e3da91e5a41791d6`.
Owner: test card `aae2`; product implementation and final acceptance: `f72f`.
Scope: `branch`, `prepare-spec`, and the existing Draft's actual start.
No future phase Result operands or alternative runtime/registry are introduced.

The frozen suite is `prepare-artifact-scenario.test.js` (53 cases, including
the existing nested P21 stale-recovery case) with
`tests/support/prepare-artifact-scenario.js`. Every fixture owns a disposable
Git repository and removes it in test teardown. No active development Flow is
used. Initial contract failures are required evidence of absent implementation,
not product acceptance. The final measurements below identify each reached
contract and the assertions that remain blocked by the absent implementation.

## Production and fake boundaries

The six P01 cases execute real `flow set init`, `flow prepare`, Git, docs scan,
and `flow get next-action` subprocesses, then discard their managers and use the
real `RunDispatchCommand.execute`, command registry, Definition, normal claim,
worker request preparation, external reply parser, seal validation and Store.
The dispatcher has a two-action limit: normal claim and the first Draft worker.
The returned safety-limit envelope and the saved completed Draft are asserted.
No preceding completion, Result, receipt, target activation, claim or next-action
is fabricated by the test. The Draft response is fixed raw JSON from the existing
`canonicalDraftDocument` helper, written by the fake external agent to the real
handoff payload and sealed by production `sealWorkerArtifactHandoff`.

The only normal-path external replacements are an executable `gh` returning a
fixed raw Issue response and the external Draft agent's raw response. Other
configured agent processes are executable tripwires, so refusal paths cannot
accidentally call a real AI provider. P02 replaces only the clock using a Date
subclass through `mock.method`; it does not require Node's newer MockTimers API.
The remaining cases use the real in-process SetInit/RunPrepare commands, real
Git and real internal scan subprocesses. Their fault injections are explicitly
local failure-boundary tests, not substitutes for the normal CLI proof.

Reused support: `fixtureRepository`, `commitAll`, `dispatchContainer`,
`requestPayloadPath`, `canonicalDraftDocument`, `workerArtifactJson`, temporary
root cleanup. Reused persistence readers: `FlowManager.canonicalState`,
`loadReadOnly`, `activityLedger`, `artifactCatalog`, `readArtifact`,
`findStepSettlementReceipt`, `WorktreeFlowBindingStore.load`.
There was no prepare-plugin seed in `tests/support/`; the existing
`post-worktree-hook.test.js` plugin setup was checked and its production manifest
and hook pattern reused in `PrepareArtifactScenario.installPreparePlugin`.
This owned helper serves both P11 failure and P20 success without copying their
setup or replacing plugin discovery/lifecycle/publication.

## Backward outcome map

| Cases | Guaranteed outcome / necessary producer condition | Authoritative storage and reload | Actual consumer / assertions | Final observation and remaining reachability |
| --- | --- | --- | --- | --- |
| P01 × 6 | Draft receives exact request and Issue snapshot (including absence), three preparation modes | CLI SetInit preparing → RunPrepare fresh root; canonical request, spec and Issue catalog publication; real Git OID, analysis file and worktree binding | Real get-next-action/dispatch → Draft handoff context, run/spec/Issue, execution-root payload path; raw Draft reply → saved Draft; then semantic preparation Results and actual receipt input | 6 fail: canonical creation/Issue/analysis/binding readbacks and real Draft worker invocation are reached. `savedPreparation(branch)` then fails on the missing branch Result, before `assertPreparedDraftInput` (including `options.executionWorkDir === executionRoot`) and case-specific Issue/path/context/Attempt/dispatch/completed-Draft assertions. Those assertions remain fixed but blocked. |
| P02 | Rereading an Action does not change identity with time or manager replacement | Fresh canonical manager per read, fixed base OID fingerprint, canonical state bytes | Real GetNextAction + FlowDispatchSession digest; repeated digest and unchanged canonical state | 1 pass: all digest, clock, manager disposal and unchanged-state assertions reached. |
| P03 × 3 | Wrong run, Issue or request cannot produce canonical Attempts | Real SetInit → conflicting RunPrepare; preparing state readback, journal and Git worktree count | Rejection, original preparing bytes, no spec root, no journal and worker tripwire absent | 1 pass (run), 2 fail (Issue/request): wrong-run rejection and preservation reached. Current Issue/request overrides are accepted, failing refusal; later atomicity checks are unreachable for those two cases. |
| P04 | Dirty branch cannot create branch or canonical Attempt | Real tracked file mutation before branch preparation | Exact branch-list preservation, no spec root, retained preparing record, zero worker calls | 1 pass: all rejection and preservation assertions reached. |
| P05 | Required config must exist in the requested base checkout | Real modified config → worktree preflight | `REQUIRED_WORKTREE_FILES_UNREFLECTED`, no canonical root/journal/workers | 1 pass: actual public envelope code and all no-publication assertions reached. |
| P06 × 3 | Journal/Git/exclusion interruption rolls back only owned effects and permits reload/retry | Real `after-journal-publication`, `after-worktree-add`, `after-exclusion-registration` fault boundaries | Journal run/OID, no pre-root Attempt, owned branch/worktree removed, preparing restored, fresh manager same spec retry | 3 fail: all owned rollback, fresh reload and retry assertions reached; each then failed on missing branch Result. Saved receipt/Definition assertions remain unreachable. |
| P07 | Worktree preparation stopped after planning remains incomplete | Stop at real `after-planning-state-publication`; independent manager reads fresh canonical root and saved branch publication | `prepare-spec` is not done, has no Result, and has no Draft Attempt before mandatory completion | Strengthened to inspect saved branch Result, receipt and normal target at the first required-plugin invocation before artifact effects. It reaches the real plugin and is initially red on the missing branch Result. P11/P12 and receipt cases own mandatory failure and evidence details. |
| P08 | Prepare completion durably selects Draft | Real preparation → manager disposal → canonical Result/Activity/receipt | Registered PrepareSpecReadyResult, source-bound single receipt, repeated canonical bytes, Definition-selected Draft route | 1 fail: fresh canonical readback lacks PrepareSpecReadyResult. Result restoration, receipt, route and repeated-byte checks remain fixed but unreachable. |
| P09 | Exact completed replay reads the same publication | Complete real worktree prepare; discard manager; repeat public prepare with same run | Same spec/run, unchanged Result/Activity/catalog bytes, same receipt | 1 fail: real completed prepare and fresh replay reached; replay is rejected because the preparing record was deleted. Same-publication and receipt assertions remain unreachable. |
| P10 × 2 | Different mode or actual base OID cannot replay | Real completed operation; mode change or a separate commit on `other-base` | Refusal with unchanged canonical bytes/Git worktree list and no workers | 2 pass: both refusal and preservation paths reached; base uses a distinct OID, not an alias. Current refusal is missing preparing state, so these passes do not prove typed receipt conflict handling; P19 owns that contract. |
| P11 × 4 | Required plugin, analysis, binding, active registration failure cannot start Draft | Real required post plugin throwing; actual scan reads malformed config; existing binding fault; addActiveFlow failure only | No Draft Attempt/Result, zero workers, retained preparing record, no active Flow/journal; mandatory preparation not done early | 1 pass (required hook), 3 fail (analysis/binding/active registration): real failures, zero workers, unclaimed Draft and rollback readbacks reached. The latter three then fail because preparation was prematurely marked `done`. |
| P12 × 4 | Incomplete mandatory publication may roll back; confirmed publication survives cleanup interruption | Real identity-binding, registry-publication, preparing-removal, journal-completion checkpoints; ready Result and authenticated receipt are read before interruption | No receipt: preparation cannot be terminal, owned rollback restores preparing. With authenticated receipt: exact canonical bytes and execution root survive. Cleanup checkpoints require a receipt; registry publication by itself is not confirmation. | 4 fail: all real checkpoints and Draft Attempt 0 readbacks reached. Identity-binding/registry-publication fail on terminal preparation without a receipt; preparing-removal/journal-completion fail on missing authenticated receipt before cleanup. The later rollback/preserved-publication assertions are unreachable. P13 independently owns semantic commit; registry publication alone is never treated as confirmation. |
| P13 × existing matrix | Before-commit failure, lost acknowledgement and unreadable receipt have distinct durable outcomes; two representative worktree `prepare-spec` response-loss and receipt-read-failure cases | Original-delegating matched Store commit observer and real receipt reader; worktree cases also snapshot Git publication and owner/journal state | Before commit: unchanged Result/Activity/catalog/lease/Git/owner. After commit with lost response: one durable publication and exact receipt recovery. Unreadable receipt: retain commit, no fallback/Error Activity and no worker | Both added representatives are initial-red `ERR_ASSERTION` failures on the missing semantic Store path. Post-guard state, fallback and recovery assertions have not run; no Cartesian matrix is claimed. |
| P14 | Canonical root starts without Attempts; journal ownership is not Step identity | Observe original real FlowManager.createFresh before/after; read real journal and canonical ledger | Fresh branch/prepare/Draft sequence 0 and null Result; subsequent branch/prepare Attempt IDs differ from journal ID; Draft remains unclaimed | 1 pass: all initial root, journal identity and unclaimed Draft assertions reached. The observer always calls the original method, never creates a state itself. |
| P15 × 2 | Live journal owner or changed base blocks retry without taking ownership | Real journal publication; local unlink failure leaves the production-owned record; fresh manager retries | Byte-identical journal, no root/worktree/worker; owner-live or base-revision refusal | 2 pass: both actual live-owner/base refusal paths and all journal/Git/state/worker preservation assertions reached. |
| P16 | Existing Git worktree requires no new Git preparation | Real Git creates an existing feature worktree; normal prepare executes inside it | Unchanged Git worktree list, direct mode, actual executionRoot, BranchNotRequiredResult | 1 fail: actual existing-worktree preparation, direct mode and no new Git effects reached; missing branch-not-required Result blocks restoration/receipt assertions. |
| P17 | Request original bytes reach Draft, including significant outer whitespace | Real preparing/canonical request → real dispatch context | Canonical request exact match and actual worker context exact match | 1 fail: canonical exact request preservation and real Draft context reached; the worker context trims significant surrounding whitespace. |
| P18 × 2 | Semantic error uses the existing shared StepErrorResult and Definition Failure | Existing module namespace + single Result registry serialization | New phase Definition presence; restored shared Error/code/data; StepErrorDecision, no target/Connector | 2 fail: existing namespace loads, but the phase Definition API is absent. Shared Error restoration/code/data and Failure/no-Connector assertions remain unreachable; there is no failed static import. |
| P19 × 6 | Owner/publication/target mismatch cannot authorize receipt replay | Capture actual typed recovery arguments after real semantic commit with lost response; original public receipt reader | Exact read succeeds; one altered boundary field returns no receipt or canonical conflict; canonical bytes and worker count unchanged | 6 fail: real producer observation reached, but no semantic Result/recovery input is produced. Captured-input assertion fails; exact typed receipt read, each altered field and no-mutation checks remain unreachable. Malformed boundary clones never create or complete a normal Flow. |
| P20 | Required plugin success must be stored, read back and bound into the actual Draft input | Shared real plugin seed → discovery/lifecycle → canonical plugin publication → manager disposal → `readArtifact` and catalog/Activity comparison | Exact plugin payload run/spec/Issue/request and hook count, descriptor/hash/Activity identity, real Draft worker, nonempty `receipt.preparation.mandatory.plugins` and actual handoff receipt | 1 fail: required plugin publication/hash/catalog/readback assertions pass and the real Draft worker is invoked. `savedPreparation` then fails on the missing ready Result, so shared input and nonempty receipt assertions remain unreachable. |
| P21 | Abrupt process exit after worktree creation recovers from persisted stale owner/journal | Real child exits with code 73 immediately after actual worktree Git add; parent confirms stale process identities, reloads production journal and retries via public prepare | Same run/spec/worktree identity, one Git publication, journal and operation lock cleared, canonical readback and real Draft consumer; no worker before retry | Nested stale-recovery prefix passes. Outer case reaches real recovery and is initially red on missing semantic Result. This covers process-exit recovery, not OS/cross-process transaction atomicity. |
| P22 | Branch publication precedes mandatory work; stop/reload/retry does not duplicate its Activity | Real `branch-not-required` Store transaction; lost response and receipt-read failure after commit; manager reload and public retry | Durable Result/receipt/Activity and prepare activation survive; no analysis yet; retry recovers exact receipt, emits one branch Activity and proceeds to mandatory preparation and real Draft | Initial red is `publicationFault.commits === 1` observing zero. The current real preparation command runs, but the targeted semantic commit is absent; stop/reload/retry assertions do not run. P07 owns the actual plugin invocation-order observation. |

## Fixed f72f API and serialization contracts

`Definition.settlePrepareStepResult(stepId, result)` is the phase entry, consistent
with the existing Draft and Spec APIs. Tests access the real existing Definition
module namespace and assert this property before invoking it. It takes only a
restored `StepResult`; no separate facts are passed. BranchPreparedResult and
BranchNotRequiredResult select `prepare-spec`; PrepareSpecReadyResult selects
`draft`; shared StepErrorResult selects StepErrorDecision. This is a test-first
API requirement, not a test implementation of that API.

The single existing Result registry must restore the exact class/kind/type/Step
identity. Canonical `NodeResult.stepResult` is already rehydrated: the shared
`assertCanonicalStepResult` verifies that instance and registry identity without
calling the JSON decoder again. The existing real Draft producer/reload case
uses the same helper before its Spec and Acceptance consumer assertions.
Existing `DraftStepSettlementReceipt.assertStored` authenticates the
Activity receipt against its actual source Attempt, restored Result and selected
Settlement. The node Result and Activity receipt must be identical. There must
be one publication Activity, a stable publication digest, and no fake Activity
IDs in the catalog.

The shared receipt gains one `preparation` value, authenticated as part of receipt
identity. This is the only new serialized value expected by this test; no second
Store, reader or registry is introduced. Its exact fields are:

| Field | Expected real evidence |
| --- | --- |
| `mode` | Fresh canonical manager's persisted `state.execution.mode`: branch/worktree/direct; no dependency on the outer prepare command returning |
| `baseOid` | Git OID captured from the immutable seed base; actual execution HEAD asserted in P01 |
| `branch` | Fresh canonical `state.execution.featureBranch`, or null for no-branch/existing worktree |
| `worktree` | Newly prepared worktree path, or null when no Git worktree was created |
| `creationActivityId` | First canonical creation Activity ID |
| `catalog` | Actual creation-Activity descriptors for immutable `spec.record`, `spec.snapshot`, optional `issue.snapshot` |
| `request` | Original preparing request, preserving exact text |
| `issueSnapshot` | Existing IssueSnapshot value shape `{number, body}`, or null |
| `mandatory` | null for branch; ready preparation stores `{plugins, analysis: {hash, size}}`. `plugins` is the actual canonical catalog's `plugin.lifecycle.artifact` descriptor list (empty in P01, nonempty in P20). Analysis hash/size come from actual output bytes. Required plugin failure is P11. |
| `bindingIdentity` | Real WorktreeFlowIdentity.toJSON for completed new worktree preparation; null before mandatory completion or in direct/branch mode |

The actual Draft `inputs[].document` must include that exact saved preparation
receipt (deep equality). Its context's run identity must match the source
receipt, and the two preparation leaves must have different source Attempt IDs.
`branch` receipts cannot claim mandatory completion. The registry result operand
extension planned for phase 02 is intentionally absent from these expectations.
The receipt assertion reads execution mode and feature branch from a freshly
loaded canonical state, including inside P12's publication callback and P13's
uncertain-commit recovery. It never requires `scenario.prepared`, which is set
only after the outer command returns. Remaining command-result assertions occur
only after an awaited successful prepare/replay; recovery-input assertions first
require the real typed input to have been observed.

The same Store/receipt fault mechanism is centralized in scenario-private
`PreparePublicationFault` for P13, P19 and P22. It delegates the original
apply/read operations, uses `once: true` for P19, captures the actual journal at
semantic publication and Git after commit, and invokes the original reader with
the actual manager during replay; restoration is idempotent. Scenario cases
retain their own outcomes, without a generic fault framework. P01/P20 reuse the
existing `assertPreparedDraftInput`; the producer and consumer remain production
code.

## Measurement and limitations

Historical frozen-candidate evidence remains under `.tmp/aae2/`; old counts
and hashes below describe those candidates only. Final code and parent evidence
are `.tmp/aae2/three-fixes-code-final.json` and
`.tmp/aae2/three-fixes-final-results.json`.

| Evidence | Scope and observed result |
| --- | --- |
| `prepare-final.log` (historical) | Earlier 48 scenario cases plus 3 production DI cases: **51 total, 10 pass, 41 fail**, exit 1. Historical only. |
| `final-case-results.json` (historical) | Exact name, status and error code for the historical 51-case candidate. Scenario subtotal: **48 total, 10 pass, 38 assertion failures**. DI subtotal: **3 assertion failures** at missing production registration lookup; later caller selection/Step/Service inspection is unreachable. |
| `phase-scenarios.log` (historical) | Earlier integrated candidate: **60 total, 21 pass, 39 assertion failures**. Superseded by final measurements. |

Latest affected-scope command, recorded in `.tmp/aae2/three-fixes-final-prepare.log`:

```sh
node --test tests/integration/flow/prepare-execution-observer.test.js tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js
```

It measured **63 cases: 18 pass, 45 `ERR_ASSERTION`, no skip/cancel**. The 53
artifact cases include nested P21; the other ten are five DI/caller and five
helper-validation cases. The earlier full 73-case run includes ten downstream
Draft/Spec passes reused after the private-only extraction; it is not a current
full rerun.

Historical full-run measurement: the full scenario log is **73 tests, 28 pass, 45 initial
`ERR_ASSERTION` failures, 0 skipped/cancelled/todo**, exit 1, 470183.881575 ms.
After required common-code extraction, only the Prepare scenario test file
changed. The latest affected Prepare scope is **63 tests, 18 pass, 45 initial
`ERR_ASSERTION` failures, 0 skipped/cancelled/todo**, exit 1, 110015.298557 ms.
All original 51 case names, outcomes and error codes match the preceding
fix-final-candidate record; the new 12 cases have 8 passes and 4 initial reds.
All 63 case outcomes/codes match the full run. The ten unchanged Draft/Spec
cases passed in the full run but were not freshly rerun at this latest
candidate. Shared checker (289/289), phase structure (3 pass/1 intended initial
failure) and related regression (10/10) are hash-verified reused evidence.
Initial reds do not show that assertions behind missing production guards have
executed. Product acceptance requires f72f to make fixed contracts green on one
candidate.

Initial code identities (SHA-256; superseded for the corrected scenario):

- `prepare-artifact-scenario.test.js`:
  `f79a169e7fcd1cc5163a833fc5fae331c138abd397a679ecbcfd55f79527079b`
- `tests/support/prepare-artifact-scenario.js`:
  `01d3e47a85a2bd492d5675ec5fb4d8ec9152f8c3d9866d743525721dc30b4caa`

Detailed case observations above describe the current fixed test contract and
are annotated with the full-run or post-extraction outcomes. Historical
per-case records remain labeled historical; they do not substitute for the
final 73-case and 63-case measurements. Earlier setup failures and old fixture
logs are not acceptance evidence. Real hook publication/readback and
Draft-consumer reachability are covered by P20; its post-Result assertions
remain unreachable at the current initial-red candidate.

No baseline historical product fix was removed. These initial-red measurements
prove neither final product acceptance nor unexecuted post-guard assertions.
The table distinguishes successful real producer/readback/consumer observations
from later frozen expectations. Product implementation and all-green acceptance
remain with `f72f`. OS crash or cross-process transaction atomicity is not claimed
by in-process fault tests. Existing Draft → Spec and Spec artifact-consumer
scenarios are not duplicated here. They were rerun in the correction's exact
board command; the Draft case additionally exercises the shared canonical
Result assertions. The old decoder call fails in an isolated copy of that real
producer/reload case (`fix-result-before.log`); the final copy passes it.
