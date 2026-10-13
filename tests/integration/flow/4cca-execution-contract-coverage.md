# 4cca execution contract and durable Acceptance coverage

Implementation base: `66f318c9e688e7cd545ed018b3808d25782de613`.
Branch: `codex/4cca`; worktree: `.sennel/worktree/4cca`.
The current board and command evidence are retained in `.tmp/4cca/`.

The CLI captures package source and resources before importing application
modules. Runtime identity names those captured bytes, independently of the
target project's Git history. A running parent supplies the same bytes to its
Review child through a transient file descriptor. An independent process
captures the current installation and refuses an unfinished contract from a
different runtime. Start through `sennel` or `src/sennel.js`; the test runner
applies this bootstrap automatically. Direct Node test invocations that use
execution contracts need `--import ./src/sennel.js`.

Acceptance keeps one claimed generation while replaying saved responses and
running remaining calls. Its execution metadata is not an Acceptance verdict
or downstream evidence. A claim without a response or confirmed failure holds
execution after reload. It grants neither another provider call nor a fresh
Attempt. Supported final receipts retain their existing replay contract.

| Observable outcome | Necessary condition and legal producer | Authoritative save and readback | Consumer and covering tests |
| --- | --- | --- | --- |
| A changed runtime cannot adopt unfinished output | Builtin bootstrap, loader snapshot, ordered source/resource identity; lazy imports use the same set | `RuntimePackageSnapshot` / `RuntimePackageIdentity`; no late disk proof | `runtime-package.test.js`, including changed/added/deleted bytes, lazy/resource reads, unproved imports and delivery tampering |
| Legitimate self-edit can finish the active Review | Normal source handoff edits the project; the parent passes its fixed runtime to the actual Review child | Transient `RuntimeChildExecution` delivery, loader validation and acknowledgement; no persisted old-runtime cache | `runtime-child-self-edit.test.js`: real source handoff, Review process, Task Gate, separate process with new revision; Node 18.19 and 22 |
| Unfinished worker, Review and Gate output has one exact owner | Registered direct/dispatch entry acquires input, binding, generation and protocol; the existing claim producer creates the typed contract | `claimExecutionContract`, Draft claim or source checkpoint transaction; exact catalog producer, input baselines and contract readback | `worker-artifact-handoff.test.js`, `review-execution-contract.test.js`, Draft/Spec phase scenarios; complete caller inventory in `.tmp/4cca/caller-ledger.md` |
| Saved progress cannot reset consumed budget | Immutable scope events, mutable frontier and latest episode budget agree; scope includes stage/round and ordered plan | Existing catalog transaction, frontier CAS, immutable-event acknowledgement; missing history/frontier/budget refuses | `canonical-prompt-execution.test.js`; episode and generation ownership, competing writer, input drift, failure atomicity and ACK recovery |
| A partial plan resumes only its remaining calls | Original ordered plan, completed responses, group/protocol/transport accounting and shared limits survive reload | Save-only `PromptExecutionJournalWriter`; typed plan and frontier snapshots; latest budget acquired outside execution | `prompt-execution-journal.test.js`: two-call cap, completed response replay, original order, group identity, cache, transport/protocol retry and bounds |
| Every durable physical attempt has a saved claim | Existing `Agent` retry path awaits common admission; only a confirmed process completion, stop or startup failure clears the claim | Claim and updated consumption saved together; typed failure observation, then bounded retry | `prompt-execution-journal.test.js`, `agent-transport-failure-observation.test.js`; proof-free `_callOnce` failure remains uncertain with no restart call |
| Cache hits do not create physical claims | Existing Agent cache and invocation identity supply the response; accounting distinguishes cache and process origins | Cache-origin raw response, schema/request/profile identity and accounting saved through the same journal | `prompt-execution-journal.test.js`, `prompt-provider-attempt-budget.test.js`; saved failure-to-cache identity checks |
| Persistence failure remains a control stop | Writer, admission, Agent, protocol, Acceptance and dispatcher propagate the original control failure | No semantic error publication, retry-counter reset or additional Attempt; exact saved event can acknowledge a lost response | `acceptance-durable-execution.test.js`: refused claim, response/validation interruption, uncertain response, changed evidence and reload |
| A new mechanical blocker cannot replace unfinished Acceptance evidence | Fresh context, input producer baselines, current binding and fixed runtime are checked through the same admission before preparation and adoption | Store requires the matching contract for claimed publication after exact receipt replay; mismatch leaves receipt, response, budget and catalog unchanged | `acceptance-execution-admission.test.js`, `acceptance-execution-settlement.contract.js`; original changed-SKILL regression also passes with unchanged inputs and assertions |
| Existing docs sync executes a proved child runtime | Both sync callers use `RuntimeChildExecution.runSync`; one fresh descriptor per child, parent bytes retained, target cwd/environment preserved | Immutable delivery JSON is serialized once per fixed module; each descriptor closes in `finally` | `runtime-child-execution.test.js`, `docs-sync-runtime.test.js`: actual build, chapter/README readback, review, failure diagnostics, resolved main root and completed outbox |
| Map, reduction and final stages preserve coverage and limits | Existing `planRound` / `advance` reconstruct reductions from saved completions; final synthesis reservation occurs once | Per-stage/round journals share the latest episode budget; complete plans preserve source refs and order | `acceptance-durable-execution.test.js`: multiple reduction rounds, saved map completion and scoped final; existing `prompt-batching.test.js` decision coverage |
| An uncertain call cannot publish Acceptance or start regression | Genuine first saved map response and second physical claim without completion proof | First completion and second claim remain execution metadata; Attempt and semantic consumption are retained | Acceptance phase A05: no final artifact, pending regression, Definition hold and zero extra calls after manager reload |
| Final transaction failure does not discard validated responses | Registered Acceptance command generates valid responses and reaches the existing final Store transaction | Transaction rollback preserves progress; final Result/artifacts/receipt/Activity/transition remain atomic | `acceptance-execution-settlement.contract.js`: fault before state publication, reload and completion with no duplicate RPC |
| Lost final ACK reuses the exact receipt | Final Acceptance publication has already committed through its registered Step and Store | Existing `commitSpecStepResult` exact acknowledgement recovery; final receipt replay precedes unfinished-runtime checks | `acceptance-execution-settlement.contract.js`: lost ACK, fresh manager, exact replay and unchanged canonical snapshot |
| Spec Gate repair keeps its existing budget and finding semantics | Normal Gate producer creates repair input; existing generation/baseRevision owner, plan and bounded reservation APIs remain authoritative | Shared contract admission on the existing checkpoint/progress/publication transactions | Spec Gate repair restart scenarios: cumulative limit, checkpoint continuation, sealed/publication replay, explicit recovery and Draft return |

Services receive acquired typed inputs and save-only writers. Step chooses a
concrete Result and Definition chooses its Settlement; journal recovery does
not select a competing Flow route. General runtime downgrade, uncertain-call
auto-retry, persistent runtime caches and other consumers' durable batching are
outside this board.

Verification is complete for the board's acceptance conditions. The following
table distinguishes single-run results from successful case measurements
combined after targeted corrections. Logs are retained in `.tmp/4cca/`.

| Required verification | Observed result | Evidence |
| --- | --- | --- |
| Full structure | 972/972 in one completed run; shared checker unchanged | `structure-integrated-final-r2.log` |
| Prompt and Agent local contracts | 88/88, including all 44 Prompt unit cases; effective configuration additionally 1/1 | `prompt-cache-confirmed-final.log`, `agent-invocation-configuration-r2.log` |
| Canonical contract and progress storage | 10/10: producer drift, lost ACK, competing claims, missing frontier/budget, continuation and final receipt precedence | `canonical-prompt-final.log` |
| Full Draft and Spec phases | Draft 7/7; Spec 7/7 in the combined Draft/Spec run, whose separate Draft failure was corrected and checked in the full Draft rerun | `draft-phase-full-r2.log`, `draft-spec-phase-full-r1.log` |
| Full worker handoff and Flow version | 254/254, including rejection, actual rollback and recovery | `worker-flow-version-full-r2.log` |
| Full Acceptance phase case inventory | 51 cases confirmed: full run 50 pass, one Gate cache-wrapper failure; that same unavailable-Review/regeneration case passed after the fix, with unchanged expectations | `acceptance-phase-full-r2.log`, `acceptance-phase-unavailable-cache-r3.log` |
| Durable Acceptance case inventory | Nine distinct cases confirmed: six in r8, final ACK in r3, map/reduction/final in r11, deferred disposition in r12 | `acceptance-durable-new-tests-r8.log`, `acceptance-final-ack-r3.log`, `acceptance-durable-map-final-r11.log`, `acceptance-durable-deferred-final-r12.log` |
| Latest Acceptance consumers | Direct saved-response restart 1/1; latest-runtime deferred consumer 1/1, legally reusing an immutable completed Gate boundary | `acceptance-durable-direct-final-r10.log`, `acceptance-durable-deferred-latest-r13.log` |
| Full normal Agent case inventory | 13 required cases confirmed: 12 pass in the full run; its one timeout case passed on targeted rerun under the unchanged 720-second limit. One historical opt-in case was intentionally excluded | `agent-full-r2.log`, `agent-draft-gate-repair-r3.log`, `agent-draft-gate-repair-r3-evidence.json` |
| Spec Gate repair restart case inventory | 36 cases confirmed: 31 in r2, four in corrections r3, full oversized input in r5 | `spec-gate-repair-restart-full-r2.log`, `spec-gate-repair-restart-corrections-r3.log`, `spec-gate-repair-oversized-restart-r5.log` |
| Spec Gate repair cumulative budget | 16 paid calls remain 16 across response publication, manager reload and completion; following call refused without canonical change | `spec-gate-repair-budget-contract.log` |
| Fixed runtime on supported Node versions | Actual self-edit, source handoff, Review child, Task Gate and independent changed-runtime refusal verified on Node 18.19 and 22 | `runtime-child-self-edit.test.js` measurements and runtime proofs |

Scope/round accounting is also 23/23
(`prompt-scope-round-config-final-r2.log`): identical plan/group names in two
reduction rounds each consume their own group cap of one and share the episode
cap of two; replay of the older completed round adds no saves or calls. Source
identity, Draft return, publication budget and canonical-value coverage totals
15 observed passing cases (`spec-gate-repair-authority-r1.log` and the corrected
Task seed case in `spec-gate-repair-canonical-task-r2.log`).

Known regressions were checked with identical inputs and expectations before
and after the relevant fix: canonical JSON order, source-recovery rejection and
Gate admission capability forwarding. The final Gate wrapper delegates cache,
failure and restored-attempt capabilities to the existing admission; it adds
no budget counter or independent retry policy. Its focused two-case comparison
failed before and passed after, with six existing attempt-budget cases also
passing (`gate-provider-admission-before-exact.log`,
`gate-provider-admission-after.log`). The full Acceptance failure's canonical
cause is retained in `acceptance-phase-gate-failure-73f4715f6e9d9ad7.json`.

Fixture correction reasons and the permitted 105,600-character complete Spec
Gate input are recorded in `spec-gate-repair-recovery-coverage.md` and
`spec-gate-repair-oversized-seed-measurement.log`. Refusal expectations, complete
input equality, digest, Unicode, reload, atomicity and call-count assertions are
retained. An incorrectly selected duplicate 16-call run was stopped, cleaned
and excluded from measurements.

The final package snapshot is runtime revision
`7173505208e68e9d03a6b2ce6dc974f2a7bfa41a34d93c339d73a2ddd889e9d3`,
851 files, independently proved on Node 18.19 and 22 in
`final-source-runtime-node18.json` and `final-source-runtime-node22.json`.
The earlier Store snapshot `c5849e08…6391a` and deferred producer snapshot
`3b71fc68…25fd` remain evidence of the bytes those processes actually used.
Successful case inventories are combined measurements, not assertions that
every suite passed in a single run under the final revision. Later corrections
were checked in their affected contracts and consumers; the final readonly
integration review found no remaining acceptance blocker.

The worktree and necessary evidence, including the immutable completed Gate
seed, remain available for review. Owned test and diagnostic processes have
completed, and ordinary temporary roots have been cleaned. No commit, merge,
push, publication, board update or actual development Flow was performed.

The subsequent code audit identified two material gaps in that earlier result:
mechanical-blocker publication bypassed unfinished Acceptance admission, and
existing docs children lacked bootstrap. Both are now corrected. The final
follow-up runtime is
`a87ac2ad6053d78fd7a65896b2a0bdf8454fdd0c44b002e83981ccca16754c69`
(851 files; `fix-final-runtime.json`). Prior runtime proofs and failures retain
their original identities; the earlier completion assessment was superseded.

Follow-up verification is limited to affected contracts and consumers:

- Acceptance admission/planning/receipt checks: 12/12
  (`fix-acceptance-admission-bootstrapped.log`).
- Manager-run producer/save/reload scenarios: 4/4
  (`fix-acceptance-integrated.log`). These cover direct/dispatch refusal with
  unchanged canonical snapshot, missing-contract final publication rejection,
  final transaction rollback and zero extra calls on resume, and exact final
  acknowledgement recovery. The original audit case body and expectations are
  unchanged; its former `claimed -> publication` violation now remains
  `claimed`, with no new artifact or canonical mutation.
- Actual docs build/readback/review and runtime child lifecycle: 6/6
  (`fix-docs-integration-r2.log`). Supported Node 18.19 target cases: 3/3
  selected (`fix-docs-node18.log`); unmatched cases are selection skips.
- Actual parent self-edit/Review-child compatibility: passed in
  `fix-docs-existing.log`. That invocation also contains old fixture failures
  and an interrupted repetitive producer; it is not an all-pass result.
- Genuine Task/Gate/Acceptance/regression/report connection and report
  idempotency: the selected existing case passed
  (`fix-acceptance-finalization-source-producer.log`). Old Gate fixtures were
  corrected to use their registered producer and shared external response fake;
  Task source changes now generate their normal file-map handoff evidence.
- Existing docs effect diagnostics, outbox skip and main-root resolution: 3/3
  (`fix-finalization-docs-compatibility-r2.log`). These effect tests now call
  `executeEffect` with legal acquired inputs, preserving every expected value;
  unrelated upstream producers are unnecessary for this contract.
- Existing commit/merge effect idempotency: 2/2
  (`fix-finalization-git-idempotency.log`). The tests use the same effect API;
  Commit's required Report evidence is generated by its registered producer.
  Commit counts, resumed flags and main-branch assertions are unchanged.

Full suites were not repeated. Independent review and the manager's source,
runtime, exact-result and diff checks found no remaining blocker in these fixes.
Detailed goal-to-evidence accounting is retained in `.tmp/4cca/fix-result.json`.

## Integration with concurrent main changes

Implementation commit `10201fdd37687ca8cf8af99ea767f1f5e2d314c4` is integrated
with main `a3bfa90db092abe8abfa449149daec2d186682a9`. Conflict resolution retains
main's documentation AI admission, usage observation, cancellation, canonical
publication identity, and shared persistence-failure classification alongside
4cca's fixed runtime, durable provider claims and continuation accounting.
Worktree dispatch remains in bootstrap before runtime capture; the semantic
CLI preserves main's command-specific error exit code.

Focused integration measurements are retained separately from earlier runtime
measurements:

- Agent, Prompt, documentation admission and provider observations: 102/102
  (`merge-agent-prompt-tests.log`). The strengthened three refusal cases passed
  again; removing only their control-failure preservation in an isolated copy
  makes all three detect the original contract violation
  (`merge-agent-prompt-result.json`).
- Runtime children, worktree dispatch, docs synchronization and process control:
  15/15 in the four selected files. Final process cancellation and actual child
  stdin/cwd/environment/fd3 delivery: 7/7 after the new child case and final
  synchronous-only options resolution (`process-cancellation-final.log`).
- Documentation AI command routes, approval and session sharing: 15/15
  (`merge-docs-ai-routes.log`). Public query root, bound work root and invalid
  input boundaries: 3/3 selected (`merge-query-cli.log`).
- Registered Draft and Spec production scenarios: 14/14 in one invocation
  (`merge-phase-scenarios.log`). These cover persisted phase artifacts and their
  real downstream Approval/Test/Acceptance use, strict stops, canonical Draft
  regeneration, advisory repairs, and complete large inline/file evidence.
- Draft failure/admission/publication recovery and Spec history rollback:
  12/12 cumulative from the eleven passing selected repair cases and the final
  refusal rerun (`merge-store-verification.json`). Review and Gate fixtures now
  generate the required execution contract through their normal commands.
  Spec rollback compares the publication boundary after the legitimate worker
  claim is saved, and also asserts that this claim is present. Original result,
  error, atomicity and no-extra-effect assertions are preserved.

The initial six-file Store run was **not all-pass**: 89 tests, 61 passing and
28 failing (`merge-store-tests.log`). Unchanged old Acceptance setup and Task
Gate publication-only settlement fixtures are outside this integration fix.
Two representative parent cases were run against an isolated archive of the
exact main revision: four registry setup cases and three obsolete Task Gate
intermediate-boundary cases fail with the same existing contract refusals;
two aggregate parent failures make nine reported failures out of ten tests.
The archive has no Git metadata. Those failures were not hidden by changed
expectations, skips, or a compatibility path. This comparison attributes the
selected failures to the baseline; it does not assert that every remaining
old test has been independently compared. No repository-wide or real-provider
suite was run for the merge.

The final bootstrap proof is runtime revision
`55f12f948097e8eeb747f3bc3365d5ca490484513779fa5bf70376a5f10c1671`
(861 files; `merge-final-runtime.json`). It proves the final captured package;
individual earlier test runs retain their original source identities and are
not relabelled with this revision.
