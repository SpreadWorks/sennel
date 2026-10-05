# Prepare implementation evidence (f72f)

## Candidate and authority

Board `f72f` implements phase 01 under `67fd`, with the common checker from
`fc21` and the fixed preparation contracts from `aae2`. The implementation
branch is `codex/f72f`; its review worktree is
`/home/nakano/workspace/sennel/.sennel/worktree/f72f`. The starting commit is
`f64c95c5b24b9d83e585de47e8f40adf4e9796dc` on `main`.

The retrieved board bodies, raw logs, comparison hashes and final candidate
hashes are preserved under `.tmp/f72f/`. The historical test-first evidence in
`prepare-contract-evidence.md` remains unchanged. Its initial-red measurements
are historical observations, not current acceptance results.

## Implementation and reused boundaries

Both preparation leaves now have production `StepRegistration` entries and
share `PlanPreparationService`. Their only constructor inputs are a typed
`PlanPreparationInput` and a save-only `PlanPreparationSettlementWriter`.
Service state is private. Git, plugin lifecycle, analysis and binding IO remain
in `RunPrepareSpecCommand` and the existing external adapters.

The Steps select `BranchPreparedResult`, `BranchNotRequiredResult` or
`PrepareSpecReadyResult`; the existing shared `StepErrorResult` selects Failure.
Definition selects each Settlement from the Result alone. The writer reuses
`FlowManager.commitDraftStepResult`, including its existing receipt recovery.
There is no additional Store, runtime phase, registry or canonical state.

`createFresh` publishes the root with no Attempt. The normal canonical branch
claim then publishes its Result, Activity, authenticated receipt and the next
preparation Attempt atomically through the existing Version Store. Branch
acknowledgement precedes mandatory hooks. The ready receipt is published only
after plugin success, analysis, worktree binding where applicable, and active
registration. It routes to Draft with no Draft Attempt; the ordinary dispatcher
claims and starts Draft.

The shared receipt includes immutable `PreparationEvidence`: mode, base OID,
branch/worktree, creation Activity/catalog, original request, Issue snapshot,
plugin descriptors, analysis digest/size, and binding identity. A coherent
canonical reader authenticates the completed producer, its terminal Activity,
Result-only Settlement and receipt. Draft uses that reader and delivers the
saved ready receipt as an actual worker input. Significant request whitespace
is retained.

Display, direct preparation, dispatch, post and recovery use the same selected
registration. The post path acknowledges an acquired receipt without executing
the Step a second time. Pending preparation cannot fall through to a worker.

Existing journal, operation lock, process identity and Git ownership checks
continue to own rollback. A dead journal owner with a committed branch receipt
can transfer process ownership while retaining the journal attempt, Git,
canonical branch Activity and receipt. Uncommitted preparation follows the
existing owned rollback path. Saved plugin artifacts replay only with the same
branch receipt, active preparation Attempt, descriptor identities and bytes.
Mandatory hooks run again after a partial restart; an artifact publication is
not proof of successful lifecycle completion.

The plugin publisher accepts both existing receipt representations: the
nominal successful commit value and the serialized document returned by the
shared lost-response recovery API. It validates them through the existing
receipt assertion and compares immutable acquired identity with the canonical
reader. The shared recovery API's return contract is unchanged.

## Acceptance map

The backward producer/storage/readback/consumer maps in
`../flow-cli/prepare-artifact-scenario-coverage.md` and the common-rule map in
`prepare-structure-coverage.md` remain the fixed acceptance authority.

| Required outcome | Fixed verification and observed boundary |
| --- | --- |
| Both real leaves; A01–A12; complete actual DI | Frozen Prepare structure plus actual registration identity, original `create`, both Service argument/private boundaries in all three modes; full shared checker positive/negative scope |
| Three modes × Issue present/absent reach actual Draft | P01: public initialization/preparation, disposable Git, canonical reload, real get-next/dispatch, actual worker request/snapshot/execution directory/ready receipt, completed Draft |
| Stable Action and exact inputs | P02, P03, P17: disposal/clock advance preserve identity; run/Issue/request mismatch refuses before publication; original request whitespace reaches the consumer |
| Admission and mandatory failures block Draft | P04, P05, P07, P10, P11, P15: dirty/config/mode/OID/owner and mandatory hook/analysis/binding/registry failure; zero Draft workers and no Draft claim |
| Ready Result, source identity and Definition connection survive reload | P08, P14, P16, P18: canonical source Attempts remain distinct from journal ownership; existing-worktree no-branch Result; shared semantic Error selects Failure with no Connector |
| Owned rollback and public interruption boundaries | P06, P12, P21: journal/Git/root/binding/registration/cleanup boundaries; a terminated child and fresh manager recover through normal preparation |
| Exact replay, response loss and unreadable receipt | P09, P13, P19: Result/receipt/Activity/lease/owner remain authoritative; owner/publication/target differences refuse without mutation; read failure adds no fallback Result |
| Plugin evidence and branch-before-mandatory order | P20, P22: actual nonempty hook publication and descriptor readback; durable branch stops before mandatory work and resumes without a second branch Activity |
| Actual journal restart after durable branch acknowledgement loss | New worktree regression: child commits, loses response and receipt read, exits; original receipt/Git survive, hooks run once, fresh manager starts actual Draft |
| Actual journal restart after plugin publication | New worktree regressions: child exits after plugin artifact commit; matching retry reuses publication and reruns mandatory hooks; changed or omitted outputs and stale publisher after Draft refuse without mutation |
| Existing Draft/Spec consumers and shared storage | Unchanged phase scenarios generate, persist and reload artifacts through actual commands/Services/Store and downstream Approval/Test/Acceptance; foundation and Draft settlement regressions |

## Fixed tests and bounded corrections

The frozen Draft, Spec and Prepare structure files, preparation DI file,
downstream scenario files, coverage maps and test-first handoff are unchanged.
Candidate hashes and baseline equality are recorded in
`.tmp/f72f/final-candidate.json`.

One preparation fault fixture assigned nominal `FlowSpecIdentity` to a field
whose public APIs and comparisons require the string spec ID. Its assignment
now calls the type's existing `toString()`. Previously it aborted before the
intended commit/readback fault. The fault, input and every assertion are
unchanged; normalization back to that one original assignment reproduces the
baseline file exactly.

One existing shared Gate mutation fixture located its target with a substring
that also matches the valid new Prepare selector. Its location string now
includes the existing Gate input line. The mutation, rule/location assertions
and restoration remain unchanged.

The shared checker previously understood forwarding terminals, but could not
prove the real selected-registration `create` → awaited Step → Service outcome
path. Its common declared-shape grammar now checks that path, same registration
and selection, actual typed inputs, full registered routing and receipt
acknowledgement. This is shared inspection, with renamed fixture phases; there
are no phase exclusions or diagnostic baselines.

Independent review added missing checks for produced capability escapes,
complete display/dispatch removal and lexical shadows of checked consumers.
They reuse `SourceOriginUsage` and the existing lexical binding reader. Valid
routes, independent bindings and restoration remain legal. Same-input
before/after logs record the capability-escape and terminal-shadow regressions.

## Historical local measurements before the OID correction

The candidate measured in this section predates the F1 OID correction below.
Its product source, shared checker, fixed scopes and additional regressions
were green together in the listed scopes. These historical measurements do not
establish acceptance of the OID-corrected candidate or the newly covered adoption
conditions. Each long command wrote its raw log before inspection. There were
no failures, skips, cancellations or todo cases in these historical final runs.

| Command group | Final result | Raw evidence under `.tmp/f72f/` |
| --- | --- | --- |
| Exact 12-file shared checker command listed in the CI checker job | 305/305 pass | `checker-ci12-terminal-final.log` |
| Frozen Draft/Spec/Prepare structure command | 4/4 pass | `phase-structure-green.log` |
| Fixed four-file DI/Prepare/Draft/Spec scope plus the three distinct worktree restart regressions | 71/71 pass | `phase-scenarios-green.log` |
| Issue snapshot, worktree binding, required post-worktree hook, canonical foundation and Draft settlement | 72/72 pass | `related-and-store-green.log` |
| Existing preparation observer boundaries | 5/5 pass | `prepare-observer.log` |
| Existing generic plugin publisher immutability | 4/4 pass | `plugin-publisher-immutability.log` |

The final shared checker additionally passed its focused six-file scope
(207/207). Independent review confirmed that the valid actual/renamed routes
pass while adoption, display and dispatch terminal callback shadows refuse;
see `checker-terminal-final-audit.log`. These counts are separate scopes and
are not summed as unique test coverage.

The final phase and regression commands were:

```sh
node --test tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js > .tmp/f72f/phase-structure-green.log 2>&1
node --test --test-concurrency=3 tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js tests/integration/flow-cli/prepare-worktree-branch-resume.test.js tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js > .tmp/f72f/phase-scenarios-green.log 2>&1
node --test tests/integration/flow/issue-snapshot-source.test.js tests/integration/flow-cli/worktree-flow-binding.test.js tests/integration/flow-cli/commands/post-worktree-hook.test.js tests/integration/flow/current-flow-state-foundation.test.js tests/integration/flow/draft-step-result-settlement.test.js > .tmp/f72f/related-and-store-green.log 2>&1
```

The runtime and shared-checker runs used the final frozen product source.
CI naming and this evidence document were finalized afterward; they do not
change execution behavior. The final hash manifest covers those final files too.

The earlier integrated candidate passed 68/68 fixed scenario cases. Adding
plugin publication replay exposed four legitimate raw-receipt recovery failures
in an intermediate 71-case run (`phase-scenarios-final.log`: 67 pass, 4 fail).
The publisher-boundary correction passed those identical four cases in
`plugin-receipt-recovery-normalization.log`; the full final candidate passed
in `phase-scenarios-green.log`. No failure is hidden by an expectation change.

Isolated copies detected the committed-branch rollback and duplicate/mismatched
plugin publication defects with the same new regression inputs. Their logs are
`worktree-branch-resume-before.log` and `prepare-plugin-replay-before.log`, with
passing counterparts `worktree-branch-resume.log` and
`prepare-plugin-replay-final.log`. Comparison copies contained no Git metadata
pointing at this checkout and were removed after preserving input hashes in
`comparison-input-hashes.json`.

## F1 correction: selected base OID and execution HEAD

Review finding F1 exposed a legitimate adoption case missing from the earlier
measurements: `--no-branch` or an existing Git worktree can execute at a committed
HEAD ahead of explicit `--base main`. `PreparationEvidence.baseOid` identifies
the selected base, while `context.gitSnapshot.commit` captures the execution
HEAD. The unconditional Store comparison rejected that valid preparation.
The retry preflight repeated the same comparison; after root publication it
could reject an unchanged base or accept a changed base that happened to match
the captured execution HEAD.

The correction reuses three existing production modules:

- `current-flow-state.js`: `CurrentFlowContext` owns bounded creation-time Git
  identities. It now validates and serializes `baseOid` using the existing
  `isGitObjectId` API, independently of `gitSnapshot`. Canonical serialization,
  reconstruction and subsequent Draft settlement preserve both values.
- `run-prepare-spec.js`: the existing `createFresh` transaction saves the
  selected `baseOid` alongside the actual execution snapshot in every mode.
  Its existing retry preflight compares the requested base with that saved OID.
- `canonical-flow-manager-store.js`: the existing
  `PreparationSettlementAdmission` compares acquired base evidence with the
  same saved base OID under the catalog lock.

The base identity is available from the initial root transaction, including
before the branch Result is committed. No mode exception, historical-context
fallback, separate helper, Store, or additional IO was added. Shared preparation
receipt serialization and query projections of the execution HEAD are unchanged.
The correction does not redefine `baseOid` to mean execution HEAD.

### Same-input regression measurements

The pre-correction candidate was copied to `.tmp/f72f/oid-fix-before/` with no
`.git` metadata. The candidate's tracked and nonignored untracked files and their
hashes are recorded in `oid-fix-before-manifest.json`. Only the two final test
files were copied into that isolated candidate. Test inputs, assertions and
fixtures are identical across the before/after comparison; production source
contains the three-file correction only in the live candidate. Tests use owned
temporary Git repositories and do not advance the development Flow or modify
its canonical state, Git authority, or evidence.

| Final regression case | Pre-correction outcome | Corrected outcome and observed contract |
| --- | --- | --- |
| P23 no-branch, existing committed HEAD ahead of explicit main | Store refuses with `Preparation evidence no longer matches its canonical owner` | Preparation saves distinct base/HEAD, reloads, returns the same receipt on exact replay with unchanged canonical bytes, and delivers that receipt to the real Draft consumer |
| P23 existing worktree at the P16 managed path, HEAD ahead of main | Same Store admission refusal | Preparation and exact replay succeed without new Git worktrees; the persisted base/HEAD remain distinct; the existing missing-binding Draft refusal preserves canonical bytes, Draft Attempt sequence 0, and zero workers |
| P24 unchanged base after root publication and before branch Result commit | Retry refuses with `saved preparation mode or base revision does not match this exact retry target` | The same public retry resumes the saved root and finishes preparation, then the actual Draft consumer reads the saved receipt |
| P24 same base ref advanced to the captured execution HEAD at that checkpoint | Retry is incorrectly accepted: `Missing expected rejection` | Retry refuses before effects; canonical bytes, preparing record, Git refs/worktree list and worker count remain unchanged |

The final regression command measured **0 pass / 4 fail before** and **4 pass /
0 fail after**, with no skipped, cancelled, or todo cases. Each before failure
detects the relevant contract violation rather than an import, timeout, or
invalid setup. The added schema case passed **1/1** on the corrected source,
covering distinct 40/64-character base and execution OIDs, serialization and
reconstruction, and rejection of invalid base OIDs.

```sh
node --test --test-name-pattern='P23|P24' .tmp/f72f/oid-fix-before/tests/integration/flow-cli/prepare-artifact-scenario.test.js > .tmp/f72f/oid-regression-before-final.log 2>&1
node --test --test-name-pattern='P23|P24' tests/integration/flow-cli/prepare-artifact-scenario.test.js > .tmp/f72f/oid-regression-after-final.log 2>&1
node --test --test-name-pattern='preserves a selected preparation base OID' tests/integration/flow/current-flow-state-foundation.test.js > .tmp/f72f/oid-schema-after.log 2>&1
```

The matching final test-file SHA-256 values are:

- `prepare-artifact-scenario.test.js`:
  `8630280e3d85144be563fae49deadc67ebb32a2ad36e9aa1a01cca2bef2276a6`
- `current-flow-state-foundation.test.js`:
  `054f386ab31a8dadcb187a1e1484f806ef9796367bb8a557554d63c5a0929d9e`

After measurements, the owned 18,907-file `.tmp/f72f/oid-fix-before/` comparison
copy was removed. The three pre-correction production files and the two final
identical test files remain in `.tmp/f72f/oid-before-product/`; their hashes are
recorded in `oid-comparison-inputs.json`. The original full
`oid-fix-before-manifest.json` and raw logs are retained. Commands referring to
`oid-fix-before/` above and below are historical execution records, not paths
to a currently retained comparison directory.

### Setup corrections and the existing worktree consumer boundary

Initial `oid-regression-before.log` / `oid-regression-after.log` measurements
are superseded and excluded from final acceptance. The new before-commit fault
initially expected the injected Error itself, but the existing production API
wraps it in `StepPersistenceFailure` with that Error as `cause`. The new fixture
was corrected to assert this established contract. The intermediate corrected
retry-only results are in `oid-retry-before-r2.log` and
`oid-retry-after-r2.log`; the final four-case comparison above uses identical
corrected setup and assertions on both candidates. Existing fixed assertions
were not changed.

The initial existing-worktree case also assumed successful Draft execution from
that tree. That expectation did not match existing authority. An unmanaged
worktree reaches `BranchFlowAuthority`'s direct-mode main-root restriction. At
the P16 managed path, `FlowManager.loadReadOnly` instead first requires a saved
worktree binding. Existing-worktree preparation adopts direct mode and publishes
no such binding. Initial path/authority expectation measurements in
`oid-existing-authority-before.log` and `oid-existing-authority-after.log` are
setup investigations, not accepted regression results.

The limited probe `oid-existing-worktree-authority.test.mjs` establishes this
boundary with the P16 managed-path setup and **HEAD equal to base**, so the old
OID comparison permits preparation. Before and after the correction it measures
**1/1 pass**: normal initialization and preparation succeed, then the Draft
context refuses the missing binding before a worker or canonical mutation.
Both candidates preserve canonical bytes and Draft Attempt sequence 0.

```sh
OID_PROBE_SOURCE_ROOT=.tmp/f72f/oid-fix-before node --test .tmp/f72f/oid-existing-worktree-authority.test.mjs > .tmp/f72f/oid-existing-binding-before.log 2>&1
node --test .tmp/f72f/oid-existing-worktree-authority.test.mjs > .tmp/f72f/oid-existing-binding-after.log 2>&1
```

P23's existing-worktree safe refusal is therefore evidence of preparation,
replay and preserved consumer authority, **not evidence of successful Draft
execution from an existing worktree**. No-branch P23 and the normal P24 retry
exercise successful actual Draft consumers. Extending existing-worktree Draft
authority would change Flow execution authority and Git strategy; that separate
scope was not changed by the OID correction.

### Corrected-candidate verification and classified parent run

The bounded commands below ran against the corrected product candidate. The
structure command completed with **4/4 pass**, exit 0, in
`oid-phase-structure.log`. The related Store/query command completed with
**105/105 pass**, exit 0, in `oid-related-store.log`. Its negative name pattern
also matched suite/file parents and did not exclude the added schema case; that
one case was rerun. This is a duplicated measurement, not additional unique
coverage or successful selective exclusion.

The existing-phase command completed with **82 total / 80 pass / 2 fail**, exit
1. Its negative name pattern likewise matched parents and loaded six
work-in-progress P23/P24/P25 cases while their setup was being corrected.
The raw log contains two expectation/setup failures: the earlier
P23 existing-worktree expectation of successful Draft execution, and the
transient P25 managed-path expectation of the direct-main-root authority message
instead of the earlier missing-binding refusal. These are the same documented
authority/setup mismatches, not accepted final assertions. The raw parent
command must not be reported as green. `oid-existing-phase.log` is preserved
with those failures. After classifying its six work-in-progress cases separately,
the unchanged P01–P22, worktree recovery, downstream Draft/Spec and observer
scope measured **76/76 pass**. Its complete case-name set matches the earlier
71-case `phase-scenarios-green.log` plus the five observer cases. This is a
classification of preserved raw outcomes, not a changed assertion or a claim
that the raw command passed. `oid-existing-phase-classification.json` records
the raw failures, separated cases and their reasons. `oid-source-audit.json`
records the unchanged source/test prefixes against the final candidate.

The final identical-input P23/P24 comparison remains **4 red before / 4 green
after**, and the HEAD-equals-base binding probe remains **1/1 pass on both
candidates**, in their separately identified final logs above. Neither the
mixed parent run nor the historical counts substitute for those measurements.
Together the bounded evidence is: unchanged phase/observer scope 76/76,
separately measured final new regressions 4/4, related Store/query scope 105/105
(including the one duplicated schema measurement), and structure 4/4. These
scopes are not summed as unique coverage. They verify the F1 correction within
its authorized scope; the existing-worktree Draft binding limitation remains a
separate authority/Git-strategy scope. This record does not declare the entire
board ready on the basis of the OID correction.

```sh
node --test tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js > .tmp/f72f/oid-phase-structure.log 2>&1
node --test --test-concurrency=3 --test-name-pattern='^(?!.*(?:P23 |P24 )).*' tests/integration/flow/prepare-execution-observer.test.js tests/integration/flow/prepare-service-boundary-coverage.test.js tests/integration/flow-cli/prepare-artifact-scenario.test.js tests/integration/flow-cli/prepare-worktree-branch-resume.test.js tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js > .tmp/f72f/oid-existing-phase.log 2>&1
node --test --test-concurrency=2 --test-name-pattern='^(?!.*preserves a selected preparation base OID).*' tests/integration/flow/issue-snapshot-source.test.js tests/integration/flow-cli/worktree-flow-binding.test.js tests/integration/flow-cli/commands/post-worktree-hook.test.js tests/integration/flow/current-flow-state-foundation.test.js tests/integration/flow/draft-step-result-settlement.test.js tests/integration/flow/query.test.js > .tmp/f72f/oid-related-store.log 2>&1
```

## CI, usage and limits

Normal usage remains public `flow set init` → `flow prepare` with its returned
run ID and existing mode flags → get-next/dispatch. No new setup or agent-host
configuration is required. The fixed scenario helpers exercise these paths in
owned disposable repositories; they do not advance a development Flow here.

Standard `npm test` discovery includes both preparation structure/DI/scenario
files and the new worktree recovery regression. `ci.yml` already makes those
directory suites part of Required CI. Discovery evidence is preserved in
`.tmp/f72f/required-discovery.json`.

After local acceptance turned green, `flow-phase-prepare.yml` transitioned from
the test-first red job to the unsuppressed `flow-phase-acceptance` job on
`codex/f72f` / `flow-phase/01-impl`. It retains the complete shared checker,
fixed phase scope, observer, existing downstream scenarios and related tests,
and includes the new worktree restart and common settlement regressions. Its
evidence upload preserves failures as well as success. The historical red
branch and test-first evidence are not rewritten.

Local execution uses Node 22.22.0 and deterministic external Issue/agent
responses. Actual Git, CLI entrypoints, hooks, filesystem, canonical publication
and downstream consumers remain in use. Hosted Actions, Node 18.19 and actual
AI execution were not run. No OS-level atomicity across Git and Version Store
or exactly-once external hook side effects is claimed. The normal required CI
retains minimum-Node and current-LTS lanes.

Generated docs were stale at worktree creation; source was used as authority
and `sennel docs build` was recommended. No generated docs or skill/preset
artifacts were changed. No development Flow, commit, merge, push, deployment or
board write was performed. The review worktree and acceptance logs remain;
owned obsolete scripts and comparison copies are removed.

## R1: use one selected base OID throughout fresh Git preparation

The subsequent review reproduced a distinct fresh-creation defect in both
branch and worktree modes. If the base ref advances after the initial OID
capture, Git previously created from the updated ref while the canonical
context and preparation receipts recorded the initial OID. This is a defect
in the recorded creation source; it does not require execution HEAD to equal
base OID when adopting an existing branch or worktree.

The correction changes only `src/flow/lib/run-prepare-spec.js`. Its existing
initial `rev-parse` result now supplies the required-config tree/blob preflight,
pending-journal comparison, journal `expectedOid`, `git worktree add`, and
`git checkout -b`. The redundant base-ref verification helper and later
resolutions are removed. The branch name remains available for execution
metadata and display. Existing Git adapters, journal ownership/rollback/
recovery, canonical context and receipt consumers are reused. No schema,
Store, registration, hook, environment-monitoring or retry mechanism is added.
This also removes redundant Git subprocesses; no performance benchmark is
claimed from test timing.

### Outcomes, producers and consumers

| Cases | Required connection and observed result |
| --- | --- |
| P25 branch and worktree | Real operation-lock acquisition delegates normally, then real `update-ref` advances the base. Public prepare creates from the captured OID, persists matching context/branch/ready receipts, reloads, and supplies the exact receipt to the actual Draft worker. Draft completes. |
| P26 worktree | The base advances after journal publication. Real branch publication commits before acknowledgement/read failure. Persisted journal OID, actual Git seed and branch receipt agree. After restoring the requested base, a new manager recovers the same Git publication and receipt, completes mandatory preparation, and feeds the actual Draft consumer. |
| P27 config preflight | Caller HEAD/config are B, and the selected base is A. A real Git wrapper advances the base ref to B while returning the initial A response. The required-config preflight still checks A, returns `REQUIRED_WORKTREE_FILES_UNREFLECTED` with `base-mismatch`, preserves preparing state, and creates no journal, feature branch, worktree, canonical root or worker. |

P26 changes only the injected external process-start fingerprint to establish
stale ownership. The same `ProcessIdentitySource` is injected through the
existing command and FlowManager constructors, including shared operation
locks. Its Git comparison snapshot is taken after the test's intentional base
ref restoration and before retry. This is persisted-recovery evidence;
actual process-exit recovery remains covered by P21 and the existing worktree
restart scenarios, rather than being inferred from that fingerprint fixture.

### Measured final candidate

The identical final four-case test has SHA-256
`68038fe2f4d30bf3988467c8dc38254d1e7c2716d0aedb7e6d20ca186d990623`
in both live and isolated before-product copies. Production source changes
from `5eec3eb5d670d624d9884bd3420e981b1be981d06028ed1644ef8c016e09d04c`
to `c3bcc1a6b30fa6e6d91d4e5afd28a3f2978a8eadc282a13dcdbca543fe60d631`.

| Final measurement | Result |
| --- | --- |
| `oid-race-new-before-final.log` | 4 failures at the target contracts: 2 actual seed/receipt OID mismatches, 1 journal/Git seed mismatch, and 1 missing required-config refusal; exit 1 |
| `oid-race-new-after-final.log` | 4/4 pass; exit 0 |
| `oid-race-existing-prepare.log` | Existing P01–P24: 57/57 pass; exit 0 |
| `oid-race-existing-resume.log` | Existing acknowledgement-loss and plugin-publication restart scenarios: 3/3 pass; exit 0 |
| `oid-race-existing-draft.log` | Draft phase scenarios, including persisted Spec/Acceptance consumption: 5/5 pass; exit 0 |

Thus the current candidate passes **69 affected cases**, with no skip,
cancellation or todo. The new and existing selections do not overlap:

```sh
node --test --test-name-pattern='^P2[567] ' .tmp/f72f/oid-race-before/tests/integration/flow-cli/prepare-artifact-scenario.test.js > .tmp/f72f/oid-race-new-before-final.log 2>&1
node --test --test-name-pattern='^P2[567] ' tests/integration/flow-cli/prepare-artifact-scenario.test.js > .tmp/f72f/oid-race-new-after-final.log 2>&1
node --test --test-name-pattern='^P(?:0[1-9]|1[0-9]|2[0-4])(?: |$)' tests/integration/flow-cli/prepare-artifact-scenario.test.js > .tmp/f72f/oid-race-existing-prepare.log 2>&1
node --test tests/integration/flow-cli/prepare-worktree-branch-resume.test.js > .tmp/f72f/oid-race-existing-resume.log 2>&1
node --test tests/integration/flow-cli/draft-artifact-scenario.test.js > .tmp/f72f/oid-race-existing-draft.log 2>&1
```

The initial P26 measurement exposed a fixture boot-identity mismatch; static
review also identified its pre-restoration Git snapshot. Both fixture issues
were corrected using the existing APIs before freezing the final comparison.
Those initial logs are retained as setup investigation and excluded from the
final regression evidence; no product assertion was weakened to pass.

The manager independently reviewed the product diff, test contracts, before/
after failures and successful final logs. Astra independently reviewed the
contract and final diff; Luna audited scope and preservation of the original
tests. Removing only the new helper, case separator and P25–P27 restores the
original P01–P24 file SHA byte-for-byte. All other recorded source files are
unchanged. The unchanged Store/schema/Query/structure contracts retain their
earlier measured evidence; they were not rerun for this IO-only correction.

The comparison input record, original manifest, root audit, per-case results
and final candidate audit are under `.tmp/f72f/oid-race-*.json`. The isolated
before copy is retained under `.tmp/f72f/oid-race-before/` without Git metadata.
The existing adopted-worktree Draft binding limitation recorded in the F1
section remains a separately demonstrated pre-existing limitation. No full
repository suite, hosted CI, minimum-Node or real-AI execution was performed.
