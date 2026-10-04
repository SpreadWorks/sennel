# Prepare structure and real DI contract (aae2)

Source baseline: `2ba144ef64c3e3cf02367895e3da91e5a41791d6`.
Worktree: `/home/nakano/workspace/sennel/.sennel/worktree/aae2`, branch `codex/aae2`.
This card fixes tests before production implementation. No product source is
changed by the two phase suites. Product acceptance belongs to `f72f`.

## Fixed scope and production authority

`futurePhaseManifests` already contains phase `01`, owner `f72f`, entry
`src/flow/steps/prepare`, composition `src/flow/engine/composition/prepare.js`,
export `prepareStepRegistrations`, and both `FLOW_DEFINITION` leaves `branch`
and `prepare-spec`. The Prepare suite reuses that responsibility set through
`PhaseStructureEntry` and `PhaseStructureManifest`; it adds the explicit execution
form `prepare-adoption` without adding another responsibility list or runtime registry.

`ProductionRegistrations.load()` owns nonempty exports, `StepRegistration` type,
duplicate ID/class, and dependency consistency. The structure suite supplies an
inspection snapshot of Draft, Spec, and every present official phase export to
the shared checker. Absent future phases do not enter phase 01 acceptance.
Present future phase exports are included in whole-registry type, duplicate,
dependency, and selection identity inspection; their own entry closures remain
their owners' responsibility. No snapshot is used to select or execute a Step.

The structure suite asserts the selected Prepare composition exists before its
dynamic import. Its initial failure is the explicit A01 production contract,
not an import failure. The DI suite first checks the real
`flowStepExecutionRegistration` for both leaves, then loads the actual phase
export and requires object identity between each selection and runtime lookup.
A synthetic phase export cannot satisfy the runtime source authority check.

## Reused APIs and tests

| Responsibility | Existing API and comparison |
| --- | --- |
| Phase scope | `PhaseStructureManifest` / `PhaseStructureEntry`; existing Draft/Spec suites and phase 01 manifest |
| Static rules and reverse references | `checkStructure`, `StructureScopeContract`, source repository/reader and shared Flow rules; no Prepare checker |
| Registry validation | `ProductionRegistrations.load()` / `.inspect()`; `staged-scope-contract.test.js` |
| Declared routing | `NamedExecutionShape`, `ExecutionCaller`, `ExecutionLoader`; `external-execution-contract.test.js` |
| Actual Service/private boundary | `ServiceBoundaryCoverage.inspectPrepared()` / `.assertComplete()`; existing Spec and Draft DI suites |
| Canonical preparation inputs | Shared `PrepareArtifactScenario.initialize()` / `.prepare()`; real SetInit and RunPrepareSpec commands; no invented typed input or prepared Attempt |

## A01-A12 mapping

| Rules | Prepare assertions and covering layer |
| --- | --- |
| A01 | Full two-leaf fixed scope, nonempty real composition export, all present official registry types/duplicates/dependencies, entry/registration correspondence both ways through shared checker |
| A02-A05 | Actual Prepare entry dependency closure through shared checker, including recursive helpers, Service indirection, dynamic load/globals and builtins |
| A06 | All-source reverse index; only composition may reference scoped Steps; `report.reverseIndexed.size > 0` |
| A07 | Each mode runs normal preparation and observes original `registration.create(input)` returns for both actual registrations; every returned `PreparedStep` is inspected by shared coverage; every constructor argument matches its declared type, dependency matches declared Service, and `assertComplete()` covers each registration even when Service types are shared |
| A08-A09 | Actual registered Service/input/Writer/preparation closure and reverse construction index through shared checker; nonempty `report.serviceBoundaries` |
| A10 | Named `prepare-adoption` contract and five display/direct/dispatch/post/recovery callers through shared checker; actual normal prepare consumes each exact original selection; two caller scenarios pass display coherence and safe public-loader/dispatch refusal |
| A11 | Both fixed Definition leaves, production lookup, three named command loaders, and adapter bypass/reverse caller inspection through shared checker |
| A12 | Shared static constructor/argumentTypes/preparation checks, plus actual two constructor arguments from each observed production preparation and their declared types |

The A07/A10 suite observes three modes (`branch`, `worktree`, `no-branch`) because
their external preparation paths differ. It does not execute synthetic
registrations, construct Services directly, pass a fabricated typed input, or
mark a canonical leaf complete. Its temporary prototype observers invoke the
unchanged original `StepRegistration.create` and `StepExecutionContract`
select/project/execute, record only the actual selected registrations, and
restore all methods in `finally` and teardown. Since both Steps may share the
same execution contract singleton, each observation uses the real `input.stepId`
lookup and verifies that registration owns the observed contract. Both actual
selects must occur; each execute must consume the same object returned by that
registration's select. An adapter declared but unused by the real preparation
caller therefore cannot pass. Project calls, when present, must also preserve
selection identity; direct preparation does not require a display call. Missing calls,
replay-only output on a fresh preparation, wrong instances/arguments, public own
data properties, and one omitted registration remain failures.

## Named contract fixed for f72f

The names below are the `aae2` test contract for the implementation card. They
are not claims that the current source already provides these functions.

| Existing module | Minimal named contract |
| --- | --- |
| `src/flow/lib/execution-admission.js` | `prepareStepExecutionContract`, `selectPrepareExecutionAdmission`, `projectPrepareExecutionAdmission`, `executePrepareSelection` |
| `src/flow/engine/composition/prepare.js` | `prepareStepRegistrations`, `prepareStepRegistration` |
| `src/flow/lib/get-next-action.js` | `projectPrepareStepExecution`: select then project on the same registration |
| `src/flow/lib/run-prepare-spec.js` | `executePrepareStepExecution`: select then execute; `recoverPrepareStepExecution`: consume supplied selection; `replayPrepareStepReceipt`: return acquired durable receipt |
| `src/flow/lib/run-dispatch.js` | `executeSelectedPrepareStepExecution`: consume supplied selection |
| `src/flow/registry.js` | `executePublishedPrepareStep`: consume supplied selection; existing `loadGetNextActionCommand` / `loadDispatchCommand`; extract current inline prepare import into `loadPrepareCommand` |

Existing worker/review/gate contracts cannot express adoption of external Git,
plugin, scan and binding evidence. The new named form extends the existing
execution contract and admission module; it does not require a new loader
module, Store, registry, or process executor. Preparation side effects remain
in the existing external adapters and preparation command. No new product save
API name is invented by these tests.

The shared checker inspects named top-level callers, but cannot prove
their connection from `RunPrepareSpecCommand.execute`,
`GetNextActionCommand.execute`, `RunDispatchCommand.dispatchContinuation`, or
`FLOW_COMMANDS.prepare.post`, including the journal recovery branch. This is a
shared `fc21` caller-boundary contract gap, reported to the main owner before
implementation. Any future static extension belongs in the common checker,
not a phase callback or local source matcher. The main owner rejected changing normal
preparation into an early forwarding branch merely to fit a static owner shape:
Git/journal preparation, canonical creation, branch adoption and mandatory
completion retain their actual nested boundaries. The proposed common
`ExecutionOwner` primitive and its reader additions were withdrawn because
this task has no valid production boundary using them. Prepare declares no
owner metadata. Static class/object owner-to-helper connection remains
unproved. Its real caller connection is
covered by the A07/A10 transparent observations above and the phase scenario's
saved Result/receipt and actual Draft inputs. Static route declarations alone
are not claimed as proof that current production owners consume them. Recovery,
post and display behavior additionally require their distinct real scenario
assertions; normal DI alone is not their runtime coverage. The common checker
change retained for this task fixes a separate A11 false positive: a legal
other-phase `executionContract` use in the same caller module must not become
a Prepare violation. Subsequent review also reproduced an array-selection
false negative. `execution-routing-provenance.test.js` now covers both lookup
and verified array provenance, forwarding, lexical identity, refusal and restored
success. It reuses the shared seed, checker, export resolver and binding reader.
No member projection or mutation parser extension is retained; undeclared
collection consumption fails closed. Pure array reexports and the existing
explicit-safe-lookup-over-wildcard positive remain accepted.

## Existing negative proof ownership

No shared negative matrix is copied into this phase suite.

| Required rejection | Existing shared proof |
| --- | --- |
| Empty/invalid export and isolated valid export | `tests/integration/structure-production-contract.test.js` |
| Missing fixed leaf even after Step source removal, single-Step exclusion, entry without registration, wrong registry membership, invalid member/duplicate/type | `tests/structure/staged-scope-contract.test.js` |
| Single-Step routing exclusion, early execution, overwritten/discarded selection, wrong lookup/loader, adapter bypass, all seven forms including prepare-adoption | `tests/structure/external-execution-contract.test.js` |
| Legal other-phase registration consumption and lexical independence, while rejecting undeclared targeted lookup/array consumption through direct, alias, namespace and forwarded bindings | `tests/structure/execution-routing-provenance.test.js` |
| Service IO/broad typed input/Writer escape and constructor/preparation type mismatch | `tests/structure/service-contract.test.js`, `constructor-invariant-contract.test.js` |
| One unprepared Step sharing an already inspected Service, wrong arguments, hidden/Symbol own property, type-only inspection insufficient | `tests/integration/flow/spec-service-boundary-coverage.test.js` |

## Local measurement and limits

Local command saved output once to `.tmp/aae2/prepare-structure-local.log`:

```sh
node --test tests/structure/prepare.test.js tests/integration/flow/prepare-service-boundary-coverage.test.js
```

Observed initial measurement: 5 tests, 1 pass, 4 fail, 0 skipped/cancelled.
The fixed scope test passes. The structure production test fails with
`AssertionError`, `ERR_ASSERTION`, expected `true`, actual `false`, naming the
missing `composition/prepare.js` export. All three actual DI mode tests fail
with `AssertionError`, `ERR_ASSERTION` because the real execution lookup lacks
the Prepare registrations. No missing future module is statically imported.

After this first measurement the DI admission assertion was changed to report
both missing leaves in one exact list, rather than stopping after `branch`;
the expected contract remains all two registrations. The structure registry
inspection was extended to include any present later official phase export.
Transparent select/project/execute observation was then added to require real
caller consumption without forcing preparation into an artificial early return.
The main owner's final structure command has since run the frozen phase files
with Draft/Spec: 4 tests, 3 pass, 1 fail at the explicit missing Prepare
composition assertion, 0 skipped. The original local log alone is not
final-candidate evidence for the changed DI observations. Final DI/scenario
measurement, shared checker green, and integrated hashes/logs are recorded by
the main owner. The structure and DI test files are frozen; this update changes
only this coverage record.

The production lookup guard currently prevents the three mode scenarios from
reaching actual Service construction, private fields/constructor arguments,
static Prepare dependency closure, named routing and caller connection
assertions. Separately, five helper boundary-validation cases pass: they verify
shared-contract registration ownership, attempted-consumer checks before
delegate invocation (including throwing consumers), and missing/unknown Step
identity rejection. A synthetic registration seed tests only the observer and
does not prove product registration acceptance. These passes do not turn the
three blocked production-mode cases green.

The following are hash-verified reused evidence, not fresh executions for the
latest correction. The reduced two-defect correction was independently checked with the exact CI
shared command: **289/289 pass**. Its same-input isolated provenance comparison
is **6 pass/21 fail before, 27/27 pass after**. Draft/Spec/Prepare structure is
still **3 pass/1 expected initial failure**. See `prepare-contract-evidence.md`
and `.tmp/aae2/fix-final-candidate.json`; earlier local measurements retain their
original revision/scope and are not relabeled as current evidence.
