# c2f6 runtime verification

This ledger distinguishes measured Flow composition from the process-runtime
and transport contracts tested at their primary layers. A named existing test is
a reuse target, not a claim that its changed-runtime version has passed.

| Acceptance | Supported observable outcome | Primary measured evidence | Limits / remaining boundary |
| --- | --- | --- | --- |
| 1 | SIGKILL resume stops identifiable provider/descendant and reads durable receipts before canonical change or replacement; a pre-observation escaped provider is refused without a false receipt or released slot | `runtime-flow-current-final.log` 12/12; runtime registry 32/32 and pure value/runtime/Prompt 75/75; frozen direct-birth 2/2 | Linux/birth/group guarantee only. Earlier source inventory transition remains unattributed; final manifest pending. |
| 2 | Admission precedes pre and spans hooks/metadata/cleanup; interruption/control failure is propagated with protected state retained | Current admission 12/12; managed supervisor 86/86; callback 3/3; dispatcher/codec 9/9 and codec 4/4; actual registered FinalRegression fault/no-publication 1/1; runtime owning evidence below | Interruption branches are measured at their primary runtime/transport layers, not a mechanical full-Flow matrix; no final whole-suite rerun claimed. |
| 3 | Descendant crash recovery and real nested Review preserve separate groups/exact bindings; managed stop/timeout and escaped-birth refusal are exercised | Current admission 12/12; managed supervisor 86/86; nested control 8/8; frozen direct-birth 2/2 | Arbitrary process containment remains outside scope; successful signaling alone is not stop proof. |
| 4 | Live/foreign/uncertain ownership refuses without unauthorized canonical or semantic effects; escaped exact birth retains slot/next BUSY | Current admission 12/12; runtime owning 32/32 and 75/75; canonical stop evidence 11/11; conditional wrong-request/dispatch negatives; direct-birth 2/2 | Identity/corruption faults are owning-layer evidence. Historical failures are not all attributed. |
| 5 | Double resume, direct Review/Gate/claim, cross-run competition, independent worktree, external vs authenticated upgrade and whole worktree→main finalization obey physical admission | Current admission 12/12; whole finalization 1/1; original F06 1/1; checkout handoff 3/3, retained handoff 7/7, pre-call 5/5, selection-state 2/2 | Same logical worktree target and sequential physical handoff are verified; unrelated historical dispatch failures are retained separately. |
| 6 | Sealed original Draft publishes once and actual Review reads its canonical digest; unsealed input/partial source/Attempt budget are preserved; policy recovery and final cleanup replay avoid duplicate effects | Current admission 12/12; source policies current/base 6/6; handoff caller 7/7; canonical stop 11/11; Draft downstream 1/1; whole finalization and original F06 each 1/1 | Earlier pure-source inventory failure is not reclassified as PASS; its primary cause remains unknown. |
| 7 | Scenarios use ordinary Node/public APIs; pure constructors, registered callers and named adapters preserve agent-independent boundaries; scoped worker-caller audit is complete | Scenario sources; nine-file pure dependency closure; A10 route evidence; finalization adapter production/negative 3/3 plus factory/expanded-negative 1/1 each; root final source scan/reviews below | Final manifest pending; unchanged baseline A06 failures remain. No complete repository-wide success claimed. |
| 8 | Narrow runtime ignore retains sibling mutation/history detection; fd 3, managed output and typed failures survive actual nested/public boundaries | Current admission 12/12; source history 3/3; supervisor 86/86; docs new/existing 4/4 each; primary-failure 7 cases; envelope 9/9+4/4; actual stop 11/11; registered FinalRegression receipt/fault/no-publication 1/1 | Owning-layer output/save/timeout evidence is separate from Flow connection evidence; old 25-case run is not claimed as a clean final rerun. |

## Producer → durable storage → fresh readback → consumer

- Busy execution: actual CLI dispatcher admits a root before external provider;
  provider persists a barrier. A second command resolves its target and must
  refuse before `pre`, then a newly constructed `FlowManager` reads unchanged
  State, Activity ledger, catalog and Attempt consumption.
- Crash/unsealed: actual provider reads its produced handoff request but writes
  no seal. SIGKILL removes coordinator authority. Resume must stop the saved
  managed execution first, then the ordinary handoff/Definition path refuses
  uncertain input without inventing a response or semantic completion.
- Crash/sealed: provider writes the declared payload and uses production
  `sealWorkerArtifactHandoff`. SIGKILL occurs while provider remains alive.
  Resume must read a durable stop receipt and the existing sealed claim, then
  the existing Step/Store publishes once. A fresh manager must expose the same
  artifact digest and settlement identity to the next Review consumer. The real
  Questions Review provider performs an independent fresh Store read before
  Refine updates Draft, and records that initial canonical descriptor and bytes.
  The final fresh manager's immutable Activity ledger must contain exactly one
  publication for the original Draft Attempt and handoff request, with the same
  descriptor Activity identity. The canonical byte hash and size, actual Review
  source marker, and persisted Review PASS must agree. Canonical serialization
  may format the worker JSON, so payload content is compared as parsed JSON;
  the saved canonical bytes and consumer digest are compared exactly.
  Refine then lawfully promotes CandidateQuestion q1@0 to AwaitingUserAnswer
  q1@1. A fresh manager verifies the latest Draft digest against its persisted
  Refine Await settlement; that subsequent publication is a distinct identity.

## Measurement status

Measured on base `f6c763ee3115d93ace6f675fa4d4e4dfe9538abb` plus the c2f6
uncommitted implementation and new scenario files:

- `runtime-flow-current-final.log`: after the production source freeze, the
  current admission file (original six cases plus root's six control-failure
  cases) passes 12/12, exit 0, 100.5 seconds, with no skips or cancellations.
  This is one normal-bootstrap run; assertions and source are unchanged for
  the measurement. It verifies typed lifecycle/registered-child refusal,
  ordinary success/failure metadata, live competition, double resume/unsealed
  refusal, sealed Draft→actual nested Review→Refine Await, and source partial
  edits/upgrade/ignore boundaries at one current runtime revision.
  Immutable evidence: `runtime-flow-evidence-7ACRpj/parent-runtime.json`, runtime
  revision `28b0ab43e1dfa5ba6258e167dea46e339c5f67e72768631530a3aa4a6bb4d484`.
  The prior pure-run source inventory failure below is retained as unresolved
  historical evidence; this current PASS does not establish its original cause.
- `runtime-flow-all6-final.log`: all six Flow composition cases pass, exit 0,
  296.6 seconds. There are no skipped or cancelled cases. Each child inherits
  the exact parent runtime; the source snapshot predates the subsequent fix
  which moves common stop-binding verification before conditional sealed
  continuation. A targeted sealed recheck measures that final fix separately.
  All-six immutable evidence: `runtime-flow-evidence-hDXXP2/parent-runtime.json`,
  runtime revision `9a1e2be3105ac85dc0f1562a9e66fc1a403e1fd78a155da410afbac0256757d8`.
  Final-fix recheck immutable evidence: `runtime-flow-evidence-VKDnS8/parent-runtime.json`,
  revision `e749dcbb255f2c6c29a8646763d662ae907d1a5bd80151f78f774a7a4bc140f8`.
  Source snapshot comparison finds only `src/flow/lib/worker-artifact-handoff.js`
  changed between these runs. `runtime-flow-sealed-stopbinding-final.log`
  passes the complete affected sealed case, exit 0, 109.9 seconds, with all
  original publication/consumer/stop/cleanup assertions retained.
- `runtime-flow-checkpoint1.log`: dispatcher success and failure lifecycle
  tests both pass. The same live slot spans `pre`, command execution,
  `post`/nonblocking or `onError`, and the actual runtime metadata writer before
  and after commit. The returned envelope appears after slot closure; a fresh
  manager reads the committed metadata exit status. The observer passes the
  original arguments to the real writer and does not replace its result.
- The same checkpoint log also passes the actual dispatcher SIGKILL / double
  resume scenario with a live provider and descendant. The old root closes
  with durable exact-call receipts; both processes cease to exist; no provider
  replacement or canonical State/catalog/Activity/consumption effect occurs.
- `runtime-flow-fixed-live2.log`: live CLI/direct Review, Gate, claim and direct
  publication recovery all refuse. A read-only next-action leaves the root
  untouched. Another run in the checkout refuses, while a valid pending Draft
  in an actual Git worktree claims and reads back its own Attempt. The owner
  remains alive and its slot/state remain unchanged until its normal release.
- `runtime-flow-fixed-source5.log`: the source provider's materialized upgrade
  succeeds through its authenticated group and delegated runtime. External
  materialized upgrade refuses before canonical publication. The real source
  baseline/manifest excludes the runtime directory, observes a lookalike
  sibling path, and retains partial edits and unsettled source authority after
  SIGKILL/resume. Attempt identity, ordinal and consumption remain unchanged.
- `runtime-flow-pre-guard-bootstrapped3.log`: before dispatcher admission was
  connected, the live CLI case detected the expected contract violation: a
  concurrent Review reached registry `pre` and returned its Step-specific
  error rather than checkout BUSY. This is the measured baseline for the
  pre-admission regression only.
- Earlier bootstrap errors, a setup barrier timeout, and the incomplete
  mid-implementation import in `runtime-flow-lifecycle2.log` are not counted as
  behavioral regression detection or acceptance evidence.

Earlier sealed replay failures: fixed-runtime runs `runtime-flow-fixed-sealed2`
through `4` reject with `FLOW_EXECUTION_CONTRACT_MISMATCH` on `inputRevision`.
Later checkpoints remove that mismatch, then the projected-state and fresh
invocation rebinding errors. `runtime-flow-sealed-replay-checkpoint3.log`
observes canonical Draft publication and the next Review Attempt in its raw
diagnostic, with one original provider call. Its actual nested Review provider
stays at durable launch intent without a launcher greeting; root closure
refuses with `PROCESS_EXECUTION_STOP_UNCONFIRMED`. These observations do not
complete the sealed replay / downstream Review assertions. Checkpoint 4 reached
actual Review and later Spec; its Draft-only fake then failed on a Spec payload.
The scenario now stops at the existing user-answer boundary, using the lawful
CandidateQuestion producer from `draft-artifact-scenario.test.js`. The provider
seed is validated by `DraftLifecycle.validateForWriterCompletion()` before OS
launch. Initial AwaitingUserAnswer seeds were invalid writer input and excluded.
Checkpoint 8 completed CLI replay with one original Draft physical call, then
failed an invalid comparison of latest Refine Draft bytes with initial payload
bytes. The corrected identity-specific boundary above is being measured; the
old comparison failure is not accepted evidence of a product defect. A later
DraftRefine worker is permitted and separately identified in the call log.
Checkpoint 9 passed canonical content/hash/size readback, but its publication
filter incorrectly expected plain request JSON to contain `requestDigest`.
That digest is a typed request getter, not a serialized request field. The
scenario now uses the public seal result's `handoffPath` to read and validate
`WorkerArtifactHandoffSubmission` before the crash, then matches both its
request digest and sealed handoff digest in the immutable canonical Activity.
Only the original provider waits at the SIGKILL barrier; the later legitimate
Refine provider seals and exits normally, avoiding an irrelevant fake timeout.
`runtime-flow-sealed-replay-checkpoint10.log` passes the complete sealed case:
one initial Draft physical call and one matching canonical publication; original
canonical content/hash/size and descriptor Activity; actual Questions Review
source digest and saved PASS; lawful Refine q1@1 Await settlement; separate
nested Review groups with exact bindings and confirmed receipts; transient
cleanup; and read-only query without another effect. This measured run does not
cover source-policy or lower-layer interruption branches by itself.
Initial source
fixtures without `baseBranch`, non-atomic marker JSON reads, and an adapter that
re-imported an already completed bootstrap are invalid fixture evidence and are
excluded. These fixes preserve the required success/refusal assertions.

Root CLI and resume CLI now inherit the parent through existing
`RuntimeChildExecution` fd 3 delivery and execute the same semantic CLI entry
selected by the public bootstrap. Each parent writes an immutable source-byte
snapshot, runtime identity, source hashes, Git HEAD/status, and tracked diff to
a unique `.tmp/c2f6/runtime-flow-evidence-*` directory. Diagnostic failure copies
are separate from acceptance assertions and are never used as replay input.

The current frozen-source 12-case run establishes the Flow connections at its
saved revision. The earlier pure-module run retains the unresolved source
failure below. Lower-layer stop,
interruption, output-failure and integrity branches require their owning suites;
passing Flow composition alone does not establish all eight acceptance
conditions. The common stop-binding final-fix recheck is complete; outstanding
companion regression boundaries are listed below.

## Companion evidence and remaining regression boundaries

The following results are reported by the root or owning agent, not rerun by
the Flow composition owner. Log names are under `.tmp/c2f6/`.

| Boundary / acceptance connection | Reported measured evidence | Status |
| --- | --- | --- |
| Registry crash, identity, admission, archived receipt readback (1–5, 8) | `runtime-crash-archive-existing-final.log` | 32/32 PASS |
| Final pure value/runtime/Prompt constructors and I/O admission (1–5, 8) | `process-values-runtime-prompt-final.log` | 75/75 PASS; root reports the nine-file pure dependency graph PASS |
| Shared managed transport/supervisor (2, 3, 8) | `transport-shared-supervisor.log` | 86/86 PASS |
| Managed callback propagation (2, 8) | `managed-callback-regression-resumed.log` | 3/3 PASS |
| Review contract and nested receipt consumption (3–6) | `review-task-binding-regression.log`; `real-task-review-receipt-fixed.log`; `review-work-unit-process-proof-regression-final.log`; `review-process-stop-history-final.log` | 6/6; 1/1; 13/13; 2/2 PASS |
| Prompt checkout authority (4, 5, 8) | `prompt-checkout-authority-final.log` | 35/35 PASS |
| Source history mutation detection (6, 8) | `source-history-final.log` | 3/3 PASS |
| Handoff recovery callers (5, 6) | `handoff-recovery-caller-final.log` | 7/7 PASS |
| Draft downstream publication/reload/consumer (6) | `draft-downstream-final.log`; Draft coverage observation diagnostic | 1/1; 1/1 PASS |
| Actual canonical Flow stop evidence save/readback/consumer (3–6) | `flow-stop-evidence-purevalues-final.log` | 11/11 PASS: Draft Questions, Spec and Task receipts, three Source cases, five conditional recovery cases |
| Conditional sealed recovery exact stop binding (4–6) | `conditional-process-stop-recovery.log` | 5/5 PASS; isolated source copies with the same wrong-request and wrong-dispatch assertions detect the before-fix violation |
| Existing Draft/Spec phase scenarios | `phase-regression-current.log` | 17/19 PASS in initial run; remaining two original cases each PASS separately above. Spec's seven cases all PASS. No combined 19/19 rerun claimed. |
| Source policy caller recovery (6) | `source-policy-caller-final.log` | Current 6/6 and base 6/6 PASS; the original three policies each use lawful fresh recovery. The detached baseline was removed after its clean-state check; logs retained. |
| Actual AI boundaries | Task Review and Draft Gate owner evidence | Task 1/1 and Gate 1/1 PASS, unchanged paths; no new actual AI run by this owner |
| Final production architecture | `structure-production-pure-final.log`; `structure-draft-baseline.log` | 8 scope cases: 6 PASS / 2 FAIL, both A06 only (three QueryStep import lines: Draft two, Spec one). Draft A06 is reproduced on base; all three import lines are unchanged on base, but the individual Spec baseline scope was not run. Pure closure PASS is separate from these unchanged A06 failures. |
| New A10 route checker and existing route contracts | Root's new checker/route evidence | 26 negative fixtures, new alias route 1/1 and existing routes 4/4 PASS |
| Direct Sync public managed admission | `direct-sync-managed-admission-final.log` | 1/1 PASS |
| Docs async public process boundaries | Owner's final docs evidence | New actual positive/typed-failure cases 4/4 and existing cases 4/4 PASS |
| Direct Acceptance managed runtime | `direct-acceptance-managed-runtime-final.log` | Corrected new case 1/1 PASS, 494 seconds. The earlier 801-second new-case failure was an invalid opaque binding field read; the test now uses the public toJSON projection. |
| Shared Acceptance A01/A05 production chain | `scenario-provider-managed-stop-final.log` | Same original assertions 2/2 PASS, 1089 seconds; actual 03→Acceptance→Report→05, with unknown throws retaining claim, budget and Attempt |
| Finalize Sync main authority | `finalize-sync-main-authority-final.log`; `finalize-runtime-observations.jsonl` | F07 1/1 PASS, 1493 seconds; observer sees main runtime and main cwd. This focused result is distinct from the whole Dispatch transition measured below. |
| Sequential checkout runtime handoff OS contract (5, 8) | `runtime-checkout-handoff-final.log` | 3/3 PASS: old physical groups closed/archived, slot clear; old worktree owner lock retained through final main close, borrowed transfer refused, deleted-worktree release uses valid main namespace. Full Dispatch integration is measured separately below. |
| Whole legal finalization Dispatch worktree→main transition (5, 6, 8) | `finalization-checkout-whole-dispatch-final.log` | 1/1 PASS, exit 0, 574.9 seconds; root independently checked the log. Actual Prepare→Report→the same RunDispatch commit→merge→sync→cleanup, public docs DI with actual managed outer/nested Node, both-slot contention refusal, reservation release after worktree deletion, and fresh-main completed-cleanup replay without canonical Activity changes. |
| Finalization owner-token plumbing regression | `finalization-checkout-whole-dispatch.log`; owner's focused context/before-copy evidence | Initial whole case refused before sync with REPOSITORY_FLOW_OPERATION_BUSY. Actual cause: FlowContext did not forward the existing owner token into FlowManager.resolveWorktreeBinding. Existing API option forwarding was corrected; focused actual Flow 1/1 and existing context regressions 5/5 PASS. The same assertion with the two old files restored in an isolated copy detects the same BUSY refusal. |
| Existing F06 removed-worktree journal recovery | `finalization-retained-active-original.log` | Original unchanged assertion 1/1 PASS, exit 0, 527.9 seconds. Lawful Prepare→Report→sync, lost-response checkpoints at prepared/worktree-removed/branch-deleted/validated/pointer-written/completed, fresh-main reread/resume, no duplicate completed effects, and valid canonical Activity receipts. |
| Canonical change between old-stop and main admission | `flow-handoff-selection-state-final.log` | Two lawful negatives 2/2 PASS for Attempt.toJSON and nodeStatus changes in finalization-process-authority.js |
| Checkout handoff evidence and fixture cleanup | `physical-checkout-handoff-evidence.md` | Root checked whole-finalization/F06 evidence and actual fixture teardown |
| Nested raw CLI control-failure propagation (3, 8) | `runtime-descendant-control-final.log`; `nested-control-after.log`; `nested-control-before.log`; `nested-control-regression-evidence.md` | Runtime 36/36 and actual nested/new+old 8/8 PASS. Three same assertions fail before the fix in isolated copies with missing expected rejection. |
| Typed dispatcher control envelopes (8) | `dispatcher-control-envelope-fixed.log`; `process-control-envelope-codec-final.log` | Dispatcher/codec 9/9 and missing-typed-payload codec 4/4 PASS; actual runtime-log wrapper preserves the nested data.processExecutionControlFailure payload |
| Actual registered dispatcher child refusal (2, 8) | `dispatcher-control-before.log`; `runtime-flow-current-final.log` | Same registered-envelope assertion detects missing expected rejection before the fix; current child case and the full admission file PASS (12/12). Fixed dispatcher/codec's separate 9-case result remains distinct. |
| Frozen sequential checkout authority and pre-call checks (5, 8) | Transport owner's retained-handoff and pre-call evidence | Retained handoff 7/7 and pre-call 5/5 PASS; the same worktree/main mismatch case detects the before-fix violation, and two identical pre-call assertions detect missing expected rejection before the fix. Whole finalization producer PASS is recorded separately above. |
| Existing dispatch CLI boundary | Original focused CLI run; `dispatch-approval-token-diagnostic.log` | Original 8/9 PASS, plus the identical final token case fresh 1/1 PASS and base 1/1 PASS with expected stale rejection. First failure cause remains unconfirmed during source edits; no combined 9/9 rerun claimed. The outer test limit changed 30→120 seconds based on two calls/36591ms ETIMEDOUT evidence; provider timeout remains 30 seconds. |
| Broad existing dispatch regression | 344-case dispatch run | 316 PASS / 28 FAIL. Raw-child bootstrap, old plan-gate schema and missing acceptance-view contract failures also observed on base. Later focused CLI timing/Acceptance evidence is listed above; historical failure causes are not all classified. This run is not a success result. |
| Earlier whole-suite snapshot | Root's 972-case run | 957 PASS / 15 FAIL, including new violations later fixed and unchanged Draft/Spec A06 failures. This is not a final whole-suite success. |
| Direct provider birth before first group observation (1, 3, 4, 8) | `direct-provider-birth-before/reproduction.mjs`; `direct-provider-birth-before/evidence.json`; `direct-provider-birth-before.log`; `direct-provider-birth-after.log`; `direct-provider-birth-after-frozen.log` | Before: confirmed actual defect, false confirmed receipt/providerKnown=false with same birth alive in state S in another PGID. Identical assertions give 1 FAIL/1 PASS before (ordinary Error, no cancellation), current after 2/2 PASS and exact-frozen after 2/2 PASS, 8.25 seconds. Fixed escape returns typed IDENTITY_UNKNOWN while exact birth remains alive, produces no receipt, retains slot and next BUSY; normal fast-birth receipt also verified. |
| Existing managed-process cases after birth recording change | `managed-direct-birth-existing-final.log` | 24/25 PASS, 1 FAIL: added durable failure reporting overwrote expected REGISTRY_FAILED with DURABILITY_UNCERTAIN on a rejected transition |
| Primary typed failure preservation and nested/pre-call regressions (8) | `managed-report-primary-failure-final.log` | Seven actual selected cases PASS: existing lawful receipt-save case, three raw nested, one forged and two pre-call cases. The shared rejectManagedControlFailure helper preserves original typed code/message/identity and retains reporting failure cause as AggregateError. Node's displayed count of eight includes a separate file with no matching case; no repeated full 25-case success claimed. |
| New finalization architecture caller registration | `finalization-structure-current-final.log`; `finalization-authority-adapter-structure-final.log`; owner's factory-final/negative-finalexpanded evidence | Initial new A11 0/1 FAIL retained; resolved by named projectFinalizationProcessAuthorityInput using the same registered lookup/select/project plus the existing strict ExecutionCaller declaration contract, checker unchanged. Actual production Finalization/lawful isolated/negative 3/3 PASS, 8.7 seconds; factory 1/1 PASS, 3.6 seconds; expanded negative 1/1 PASS, 2.1 seconds, including wrong registration/replacement selection. Distinct from unchanged baseline A06. |
| Spec-local/project test execution and final regression physical calls (1–5, 8) | `managed-test-regression-first.log`; `managed-test-regression-corrected.log`; `managed-test-regression-crash-final.log`; `managed-test-regression-before.log` | First spec-local/nonzero-project two-receipt readback case PASS, but initial suite is 1 PASS/4 FAIL from invalid setup/teardown and is not a suite success. Corrected timeout/heartbeat/ENOENT and direct two-command BUSY cases give 2 PASS; that run's new crash case failed an invalid raw getter read. Corrected typed receipt recovery crash case 1/1 PASS, 7346.9ms, receipt before successor. Isolated old caller versions detect the identical first/BUSY assertions, 0/2 PASS, 2435.7ms. |
| Shared test execution classifier and output contracts (2, 3, 8) | `managed-regression-classifier-existing-final.log`; `managed-test-overflow-final.log`; `managed-regression-structure.log`; `managed-regression-impl-structure.log` | Pure policy/classifier 25/25 PASS, 8645.9ms; managed output overflow 1/1 PASS, 2870.9ms. Acceptance actual production structure 1 PASS (separate no-match file does not prove Impl); actual Impl+Task 2/2 PASS, 15111ms. Managed overflow is typed refusal; nonruntime max-buffer contract is retained. |
| Actual Acceptance phase runner-control frontier | `managed-regression-control-script-final.log`, session 93254 | 1/1 PASS, exit 0, case 231318ms / overall 234078ms, no skip/cancellation; root directly checked the log. Lawful AcceptancePhaseScenario upstream→existing node project-tests/smoke.test.js→actual registered FinalRegression→confirmed physical receipt→injected finishCall control fault→exact ProcessControlError.fromEnvelope (nonretry, binding IDs). Entire canonical checkpoint after the fault remains unchanged, including budget/metadata; raw log absent, receipt fresh-read confirmed. Config.validate/parse/script existence were asserted before measurement. |
| Runner-control invalid new fixture history and retained-root cleanup | Earlier session 58757 and setup logs; `managed-regression-config-failure-retained-evidence.json`; `managed-regression-cleanup-retained.log` | The 237967ms absolute-node eval discovery refusal and earlier 217.9-second missing-config case did not measure the intended fault. Missing sync Gate contract, async file-map trust, config file, invalid absolute eval parse and node-eval Config refusal remain distinct invalid inputs, not before/after behavior evidence. Retained config-failure root was nonretryable under existing Definition, with no canonical alteration; three groups ESRCH/known births nonlive and evidence preservation preceded cleanup. Current success used normal teardown. |
| Finalization migration physical hook and direct admission (2, 5, 8) | `finalize-migration-runtime-after-corrected.log`; `finalize-migration-structure-final.log`; `finalize-migration-resume-final.log` | New actual cases 4 PASS, Finalization production structure 1 PASS and unchanged legitimate crash/resume producer 1 PASS, about 66 seconds. Shared managed async hook/caller await plus direct RunFinalizeCommit root guard are measured. |
| Migration same-assertion regression comparison | `finalize-migration-comparison/before.log`; `finalize-migration-comparison/after.log`; `finalize-migration-comparison/manifest.json` | Isolated before 0/1 PASS detects actual call count 0 versus expected 1; after 1/1 PASS, source differences only the two migration caller files. No unrelated source changes are used as the regression baseline. |

The completed focused evidence and the broader incomplete regression are kept
separate. Base-reproduced failures do not excuse unclassified failures, and
focused success does not replace the outstanding whole-caller audit (7).
The raw-child bootstrap failures were reproduced on base (same three cases);
the old plan-gate unsupported-schema failure was also reproduced on base.
The typed canonical physical authority and sequential runtime handoff fix is
frozen and retains the logical worktree target. The proper whole-finalization
producer now measures the complete worktree→main Dispatch transition above;
its result is distinct from the lower-layer handoff, F07 and 12-case admission
results. The original F06 removed-worktree recovery and the two new
stop→main-admission fingerprint refusal cases pass independently; these results
do not classify every historical failure. The later native-birth and managed
reporting helper source differs from the saved 12-case runtime. Its selected
primary-failure checks are recorded separately; no repeat of the full admission
file or full managed-process file is claimed.
Only the authorized current 12-case run was added after this source freeze,
with ordinary unique-fixture cleanup; no loop reruns, other suites, actual AI,
Flow, baseline checkout operations, or source/assertion edits were performed.

The final dependency separation moves sole value constructors into pure
modules, captures I/O through the admission factory, and removes the dynamic
RunDispatch import by sharing the sole FlowDispatchLease class. Runtime
authority/record/schema contracts are reported unchanged. The fresh actual-CLI
all-six run in `runtime-flow-all6-pure-final.log` completes with 5/6 PASS,
exit 1, 231.0 seconds. The source case's external-upgrade refusal leaves
canonical State unchanged, but its runtime inventory changes from active and
accepting to stopping and nonaccepting before the deliberate SIGKILL. The call
has one additional known member and no stop receipt yet. The source case lasts
21.5 seconds, shorter than its provider's 120-second deadline. A diagnostic
source-only run retains child stdout/stderr and raw registry to determine the
cause; no expectation is relaxed. `runtime-flow-source-pure-diagnostic.log`
and `runtime-flow-source-pure-diagnostic2.log` each pass the original complete
source case (22.4 and 22.8 seconds). These successful reruns do not establish
the cause of the earlier runtime transition. Its initial teardown removed the
raw record, so the original control failure errno remains unconfirmed. On any
new inventory mismatch the test retains both the immediate child/registry
diagnostic and the original dispatcher's completed result. The earlier
six-case PASS does not by itself verify this later source revision. The owned
test and provider helper contain no old FlowBinding.capture calls.
The fresh immutable evidence is `runtime-flow-evidence-uGgmVn/parent-runtime.json`,
runtime revision `c1d3e83d058cab7dc25a0e9f23023166a0975dd848cf2fcb6936f8be4dc18012`.
`runtime-flow-source-pure-diagnostic3.log` also passes the original source case,
36.6 seconds. The finite three diagnostic reruns are complete; the earlier
inventory transition remains an unresolved observation, rather than a proved
fixture error or a proved external-upgrade side effect.
Diagnostic runs 1 and 2 have the exact all-six source revision above, with
snapshots `runtime-flow-evidence-q66zrw` and `runtime-flow-evidence-8DxQ4I`.
Run 3 captures the later source revision
`b66f90def603708cf81b519b2ae7ee448cf942b6f134bc0bfd129ddb51d3cf08`
in `runtime-flow-evidence-MeKIIz`; it is not presented as same-revision evidence.

The direct-provider escape defect is confirmed and its minimal native PID/birth
recording fix now has identical-assertion before/after evidence. The comparison
in `direct-provider-birth-before/comparison.json` records test SHA-256
`299de6cfc93962cf6299ed9d54416df82822c7d22520042f7957fffd85d75905`.
Only `src/lib/managed-process-launcher.js` differs: before launcher hash
`7662d57a09e1ceb8237a57ec631edaff2e8e08131930da511cfc73539ae9770f`,
after `9906aa58a66f056c9aea886f1ec8f56111a8ed294c5e73ddb0aaf0d00f09c606`.
The primary-failure-preserving managed process helper hash
`085a1ca5633aaef7f8be1852a013837206e50cb7ba2692833c77ac0925f3fbd4`
is common to both versions. Comparison runtime revisions are
`060f27a06c2ef6f06820b9ac6d54911e73cb4a42825d327406d2c6039cf44908`
before and `5522736de3b8c7474e108c6197303eeff0aed8e250241cddce8385e85596824b`
after. These later scoped tests are distinct from the older frozen 12-case
source; no full 25-case clean rerun or npm all-green result is claimed.
The new A11 registration defect is also resolved with unchanged-checker
production/negative evidence. Root's finite review and cleanup are complete;
remaining work is the final evidence manifest. The historical source inventory failure remains an
unattributed risk, and baseline A06/broader-suite results remain recorded; these
are not erased by the accepted scoped outcomes above.

## Additional worker-caller audit and scope

The root's subsequent worker audit found an unmanaged `runProcessDetailed`
execFile path used by RunTestExecute and FinalRegression. The transport owner
connected the three Flow caller files and the shared managed-process provider
first-observed event, added common root guards to the two direct command
classes, and moved typed refusal handling before issue/discovery/skip effects.
Shared managed scope now uses executeManagedProcess's raw provider-start event
with the existing classifier; one common heartbeat class starts from the
observed provider start. These are reported implementation facts and the
focused real-process results above, not a claim from the older frozen 12-case
source. The root's limited static runner-delta review found no additional issue;
the actual Acceptance frontier is now measured by the lawful script case above.
All six new runner cases pass through their required focused measurements; no
duplicate full-file rerun is claimed.

Generic FlowAtStepFixture attempts with missing synchronous Gate contracts or
missing async file-map trust are invalid new setup and are excluded from
accepted before/after failure evidence. Older tests using that fixture's Gate
producer shortage are kept separate as existing regressions. The newer lawful
AcceptancePhaseScenario initially reached the intended target but its invalid
absolute-node eval command was rejected by discovery before the control fault.
The corrected existing script's Config.validate, parse and existence checks
precede the successful actual fault measurement above. No assertion was
weakened and no canonical rollback was used to obtain that result.

Migration changes are limited to run-finalize.js's shared async
runManagedCmdAsync hook/caller await and RunFinalizeCommit's direct root guard.
Physical hook management is demonstrated through its helper/API and real OS
tests. The current V1 artifact catalog rejects scripts/finalize-migration.js as
unclassified: canonical Flow migration-hook availability is therefore not
claimed. Extending that catalog is outside this scope; no valid catalog
assertion was weakened to make the hook usable.

Worker-caller scope includes providers, Review, docs build/review child CLI,
spec-local and project tests, and arbitrary migration scripts. Synchronous
git/gh inspections are outside execution-worker scope. Prepare's docs scan is
internal analysis/materialization only, with a 600000ms limit, no provider and
no code/source writes; it is also outside that scope. These scope decisions
are the root's assessment, distinct from the measured caller results.
Containment of arbitrary outside processes and atomicity of every OS command
are excluded. Root's final source scan confirms the only Flow raw execFile
test/regression branch is the nonruntime fallback, and the only synchronous
Node path is bounded prepare docs analysis excluded above. Every required
worker caller in this stated scope uses the common managed API; this scoped
caller audit is complete. Root's delta review and finite cross-agent review
found no additional issue; git diff checks and project-specific hardcode scan
PASS. These are root-reported static checks, separate from measured receipt
and canonical guarantees. Historical source attribution uncertainty, unchanged
A06 and broader suite failures remain; no npm all-green result is claimed.
