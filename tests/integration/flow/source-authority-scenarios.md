# CLI-owned source attribution

The source worker reports completion and required semantic evidence. The parent
captures the current Attempt's mutations and binds every mutation to every
canonical Requirement in that Task or implementation scope. A requirement/file
association identifies evaluation scope; it is not evidence that a Requirement
passes review or Gate.

## Outcome-to-condition mapping

| Required outcome | Producer and necessary conditions | Durable boundary and consumer | Primary coverage |
| --- | --- | --- | --- |
| Inherited dirty files do not become the next Task's changes | Parent captures an Attempt baseline before the worker and a manifest after it; canonical Task mapping supplies all Requirement IDs | Parent materialization and sealing, Store publication, fresh `FlowManager`, cataloged file-map and Task lineage | `worker-artifact-handoff.test.js`: `derives durable Task file effects…` |
| Shared files, later changes, additions and deletions retain their Task ownership | Each Task has a distinct Attempt manifest; file-map updates preserve earlier associations | T8 → T9 → T10 publication and readback; prior manifests remain immutable | Same history scenario |
| No-change does not fabricate a file association | Empty observed manifest and the existing required no-change reason | Empty effect files; no new empty file-map entry; durable no-change Task lineage | Same history scenario; `task-review-no-change-continuation.test.js`, `task-review-round-exhaustion.test.js` |
| Missing, stale or contradictory canonical scope is refused | Task context is generated from the canonical Task/Requirement map and verified before materialization and reconciliation; Store compares the effect with its freshly read Spec and current Attempt | Refusal precedes source publication and formal completion | `task-canonical-context.test.js`; `worker-artifact-handoff.test.js`: `rejects non-canonical Requirement or mutation bindings…` |
| Every current Task Requirement sees the complete Task source | Cataloged Task lineage supplies current source; canonical Requirement scope produces the all-to-all relation | Review prompt and actual `RunGateCommand` evaluation with a fake external agent | `commands/review.test.js`: `maps every canonical Task source path…`; `gate-diff-compaction.test.js`: `evaluates every current Task source file…` |
| Shared evidence does not multiply prompt size or calls unnecessarily | Shared source relation is rendered once; overlapping diff paths are deduplicated; batch sizing includes that relation | Review/Gate prompt construction and provider boundary | `gate-diff-compaction.test.js`: requirement diff authority and one-call Task evaluation; `commands/review.test.js`: compact scope prompt |
| Oversized evidence is never silently dropped | Prompt budgets account for source and shared scope; Task source is not passed through a Git-diff-only compactor | Explicit failure before an agent call | `commands/review.test.js`: oversized Task Review; `gate-diff-compaction.test.js`: oversized Task source and scope-aware batch splitting |
| Repair evidence and restart authority remain binding | Applied triage findings, finding-to-mutation coverage, recurrence evidence, Attempt/baseline and allowed Task lineage retain their separate checks | Review → triage → repair → re-review → Gate; sealed recovery reload and refusal after unauthorized source/HEAD/index changes | `task-review-stages.test.js`, `task-review-causal-scenarios.test.js`, `task-source-handoff-recovery.test.js`, checkpoint/publication/accounting tests |
| Malformed reports and unauthorized effects remain failures | Strict worker schema and parent source authority validate semantic evidence, source policy, actual files and Attempt identity | Seal, catalog/Activity publication and formal completion remain required | `worker-artifact-handoff.test.js`; `provider-schema.test.js`; real `tests/agent/worker-artifact-handoff.test.js` |
| A failed Gate can be read back and classified without losing source authority | Every Task Gate result passes final source and canonical-input revalidation before promotion | Semantic failure publication, fresh manager facts, Definition classification, metric and issue settlement, retry claim | `gate-source-authority.test.js`; `gate-transition-boundary.test.js`; Gate cases in `canonical-flow-manager-runtime.test.js` |
| Tooling and oversized-input failures remain blocked after reload | Failure results retain source fingerprints without granting a semantic PASS or retry authority | Formal result publication, fresh facts, Definition blocked disposition | `gate-source-authority.test.js` |
| Reuse saves evaluation work only for the same canonical input | Producer-owned Gate history carries an evaluation scope covering phase, Task, source, canonical input and guardrail definitions; incidental Activity/catalog changes are excluded | Fresh history read, scope comparison, requirement planning and guardrail result handling | `gate-source-authority.test.js` |
| Git pathname encoding and renames cannot erase mapped evidence | Shared Git segments retain decoded path aliases and separately retain unparseable text | Diff collection/filtering, per-requirement selection, compaction and call planning | `gate-diff-compaction.test.js`: mixed input, real Git paths, rename/deletion, and explicit unparsed evidence |

The history scenario uses the existing fixture's legal Review/Gate settlement
path to move between Tasks. It does not alone prove semantic Review/Gate
execution. The separate consumer and lifecycle scenarios cover those decisions
and their persistence boundaries; their assertions must not be replaced by
successful fixture settlement.

## Regression comparison

The comparison uses Git-disconnected copies of the product, with the same
history scenario, source mutations, transitions and success assertions. Only the
fake external provider's response follows the schema advertised by each copy.
Under the old contract it includes the erroneous inherited-file classification;
under the new contract the response has no file-classification field.

The old implementation must fail at T9 because the inherited path is absent
from the current Attempt manifest. A schema/import failure does not count as
detection of this fault. The corrected implementation must publish T9, read it
back and complete the later history assertions. Do not run this comparison by
editing an active Flow, its evidence, or its worktree.

These deterministic scenarios and the real-agent suite do not establish
OS-crash recovery, all possible process interleavings, or the ability to resume
an already stopped historical Flow. Such a resume is outside this change.
