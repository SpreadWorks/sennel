# 5ab3 cleanup ref observation and recovery fix

This follow-up resolves the P2 recorded in `.tmp/5ab3/code-review.json`.
The prior completion assessment did not cover a failed feature-ref read that
certified branch deletion while the branch remained. Strict journal recovery
then correctly rejected the false checkpoint and could not continue.

## Contract and implementation

The existing successful exact `for-each-ref` inventory used by journal recovery
is now shared as immutable `GitRefObservation` in `src/lib/git-helpers.js`.
Only a successful, well-formed inventory proves an exact OID or absence.
`GitRefProbeError` preserves the subprocess failure; malformed and duplicate
exact rows cannot certify absence.

The existing deletion helper owns initial observation, worktree ownership,
expected-OID CAS and failed-CAS reconciliation. The teardown calls it directly
and advances `branch-deleted` only after confirmed deletion or confirmed
absence. Unknown reads preserve the last truthful `worktree-removed` phase.
The same observer is used by teardown validation and journal recovery.

No new state Store, lock, runtime phase or retry budget is introduced. The
original Execution receipt, outbox key/attempt, main authority and one-use exact
recovery remain authoritative. Both a retained original ref and a genuinely
absent ref after lost deletion acknowledgment can resume through that policy.
Changed/recreated refs and unavailable observations still refuse.

Compared APIs: `runGit`, `deleteFeatureBranchForCleanup`, `validateTeardown`
and `FinalizeCleanupEffectPreparation.assertCurrent`. Their ref observation
responsibility is shared; transition decisions remain in Definition. Normal
deletion uses the same number of Git subprocesses. Recovery removes a duplicate
branch query after acquiring the same exact inventory. These are static command
counts, not a wall-clock performance claim.

## Verification

| Scope | Outcome | Evidence under `.tmp/5ab3/` |
| --- | --- | --- |
| New isolated value and real-Git component contracts | 13/13 pass, zero skips | `ref-fix-focused-final.log` |
| Same component regression on isolated candidate 9 | 1/1 detects unsafe success | `ref-fix-component-before.log` |
| Same genuine producer cases on isolated candidate 9 | 2 pass, 2 fail at false journal phase | `ref-fix-producer-before.log` |
| Same genuine producer cases after fix | 4/4 pass, zero skips | `ref-fix-producer-after.log` |
| New permanent registered producer scenarios | 2/2 pass, zero skips | `ref-fix-permanent-producer.log` |
| Dedicated finalization architecture | 88/88 pass, zero skips | `ref-fix-structure.log` |

The producer cases use real saved upstream Report evidence, registered commands,
Git, canonical Store and reconstructed managers. Only external Git responses
are injected. They cover initial query IO, failed deletion plus unknown readback,
actual deletion with lost acknowledgment plus unknown readback, and a normal
control. After an interrupted outcome they assert ordinary retry refusal without
mutation, read-only exact recovery advice, the authorized new Attempt with the
same outbox identity and original failure, rejection of a second reopen, one
actual deletion and one Completion, preserved Report bytes, raw Report display,
status and exact public replay without new Git or canonical effects.

The two new permanent cases reuse the existing suite's cleanup seed. The
existing eight scenario bodies are unchanged. Parent diagnostic runs with an
incorrect Report-show invocation remain separate rejected harness history;
their correction changed only the call to the existing raw Report-show API,
not product behavior or checkpoint/recovery expectations.

The immutable before source was rebuilt inside the task worktree from base
`d2de9168115a341e38aee5fe817de129ac2cb980` and captured `candidate-9.patch`.
All original 1622 source/test hashes matched candidate 9 before comparison.
Live source, main checkout, canonical state and producer seeds were not rolled
back or modified for the comparison.

Current source/test revisions and complete case diagnostics are recorded in
`ref-fix-candidate.json` and `ref-fix-evidence.json`. Changes are limited to three
source files, two new focused test files and new cases in the existing registered
cleanup test. The independent reviewer found no additional material defect.

Existing candidate-9 results are reused only for unchanged boundaries; they are
not represented as runs on this follow-up revision. Its 16 known baseline
regression failures remain recorded. No full repository suite, live GitHub
publication, docs rebuild, commit, merge, push or board mutation is claimed.

Decision: the demonstrated P2 is resolved and its connected refusal, recovery
and downstream completion contracts are verified. The task branch/worktree and
necessary evidence remain available for review.
