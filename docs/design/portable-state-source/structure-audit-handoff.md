# Whole-source structural audit handoff

The user separated general analyzer limitations from e799's functional completion
on 2026-11-07. Actual e799 OS gaps, unsafe behavior, common-API bypasses, duplicated
responsibilities, stale consumers and introduced false PASS results still require
resolution. There is no exclusion, baseline waiver or increased analysis budget.

## Falsification and withdrawn inference

After the 770-case v17 regression, six same-input programs that replace the
global Object or its freeze method, directly or through Reflect, incorrectly
returned PASS on both pinned Nodes. That invalidates the additional inference's
qualification. The post-C235 OS inference implementation and its complete
feature-specific test changes were withdrawn together. The committed
`tests/structure/os-inference-withdrawal.test.js` retains the counterexamples;
original baseline expectations were restored byte-for-byte, rather than weakened
or skipped.
This is withdrawal of an implementation, not a numerical baseline exemption.

The six programs now return incomplete/NOT_PASS on both Nodes. Eleven focused
regressions pass on both Nodes. A normal environment spread also remains an
unsupported analysis shape: this does not disable environment copying in the
product. Safely adding that inference requires separately proving mutable native
intrinsics and their escapes. No such new proof system was added to e799.

Shared source-reader safety fixes remain. A small conservative path check also
retains every possible logical operand at its actual filesystem consumer; it does
not fold branches, infer operator precedence or confer callable authority.
Consequently, some unreachable literal fallbacks may remain false positives.

## Adopted analyzer: retained current results

The unfiltered public command `node scripts/check-os-independence.js` was run on
the validated e799 feature snapshot before integrating the existing main plugin
archive change, including all nine physical instruction aliases. Linux Node
26.12.1 and18.19.0 returned exit2, `complete: false`, `ok: false`,27 violations and
6,226 incomplete findings each. Their raw reports are byte-identical. Analysis
budgets and observed scope were unchanged; this whole-source audit is NOT_PASS.

The report observed1157 source inputs, digest
`e4dfcac673d708377de89e211ad5721e439df5613c9407e1574e4c1122d3568b`.
Its uncompressed JSON SHA-256 is
`4c79fecec25d2ea74297119b787a1860bccf0bca798cf386007a7dd09aa699b1`.
The validated runtime fingerprint is
`ef9e2338442cd6bf36a83f58c162625cc7feac2f1662ffcb55b6b7f970245367`.

- [Complete raw report](structural-audit.json.gz), gzip-compressed without changing
  the JSON bytes, preserves every diagnostic, source hash, trace and coverage field.
- [Concrete source reviews](structural-review.json) retain four production-site
  reviews and23 test-infrastructure reviews without altering the raw result.
- [Validation summary](validation-summary.json) records source identity, all nine
  requirements, functional results and the revised acceptance scope.

Temporary transcripts, runtime namespaces and working copies are retired after
verified main integration at the user's request. The committed artifacts above
retain the results needed for this handoff. They describe the validated feature
snapshot and do not claim a new whole-source audit of the later merged tree.

The most frequent remaining incomplete families are:

| Diagnostic family | Count |
| --- | ---: |
| method receiver has no single inspected value | 1,454 |
| OS-sensitive capability escapes to an uninspected consumer | 1,184 |
| object spread has no inspected data members | 700 |
| source inspection incomplete | 453 |
| unsupported binding pattern obscures the capability origin | 447 |
| unsupported operator obscures an OS-sensitive value | 363 |
| computed access obscures an OS-sensitive capability | 282 |
| conditional helper capability origin cannot be proven | 197 |

Earlier focused OS/reader regressions passed 684 tests on each pinned Node;
their qualification remains bound to their exact recorded source and inputs.
The v17, v26, v29 and v67 raw reports retain their historical NOT_PASS results.
No focused regression or manual boundary review changes the current raw result.
The handoff itself is outside the audit's observed source inventory. Every
observed source hash was checked again after the initial documentation publication.

## Remaining analysis work

| Cause | Representative shape | Required scope and remaining uncertainty |
| --- | --- | --- |
| Receiver alternatives, binding writes and recursive origins | Data-only string accumulation and Map/Set operations in `src/lib/portable-path.js` | Extend existing value and reaching-origin contracts with context-qualified data propagation. Preserve native capability/path provenance, unknown receivers and same-instance nominal proof. No generic recurrence or heap model was adopted. |
| Spread, destructuring and helper results | Native JSON data, copied records, defaults and returned aggregates | Reuse shared reader/projection contracts. Prove mutation, getter, reviver, prototype and opaque-consumer behavior; do not declare all unknown data safe. No JSON-result whitelist was adopted. |
| Dynamic loading, computed access and provenance cycles | Runtime-generated module/member selections | Resolve only proven finite source edges through SourceGraph and lexical identity. Opaque edges remain incomplete; never execute target code to inspect it. |
| Finite work exhaustion | Repeated helper/member metadata evaluation | Measure context-safe reuse while preserving observed effects, later native sinks, caller/default/constructor context and invalidation. Existing work limits remain unchanged. An earlier unqualified constructor-parameter cache was withdrawn. |
| Direct-launch diagnostics | The shared owned coordinator/bootstrap boundary and test infrastructure | Inspect concrete callers and typed launch/ownership contracts. Actual e799 bypasses require product fixes; proving an existing shared lower boundary needs source-based proof and negative cases, never a filename or class-name exemption. All raw diagnostics remain visible. |

The direct owned Node control handle in `RuntimeChildExecution.spawnNode()` is
called by `CoordinatorChildControl.launch()`, through the shared runtime delivery
API, for the fixed coordinator resource. Actual child exit owns delivery release;
the mailbox retains terminating replies. This is an existing lower execution
boundary, rather than an e799 domain call that launches Git directly. The raw
checker has not established that full contract and its finding remains recorded.
Domain restore commands continue to use `runGit`, `GitOwnedStagePolicy`, owned
TemporaryPaths and AtomicFile publication.

The additional permission-metadata diagnostic concerns `FilePermissionHint`,
which copies native permissions on an already owned descriptor; it does not
establish state ownership. Node's Windows implementation supports descriptor
permission changes through the native read-only file attribute. Git logical
executable authority is separately observed through native Git. This manual
review does not constitute native Windows validation. See the
[Node API contract](https://nodejs.org/download/release/v18.19.0/docs/api/fs.html#fsfchmodsyncfd-mode)
and the bundled Windows implementations in
[Node 18](https://raw.githubusercontent.com/nodejs/node/v18.19.0/deps/uv/src/win/fs.c)
and [Node 26](https://raw.githubusercontent.com/nodejs/node/v26.12.1/deps/uv/src/win/fs.c).

The bootstrap diagnostic concerns the shared, fixed Git discovery probe before
managed runtime admission. It uses `GitRepositoryPolicy`, a closed two-operation
set, isolated Git configuration, bounded execution and explicit failure handling.
The default ceiling defect found by the existing CLI test was corrected through
that same policy; caller-selected explicit ceilings remain effective. Existing
CLI 23-case and worktree CLI six-case files pass on both pinned Nodes. The analyzer
still lacks proof of this lower boundary, and its finding remains visible.
`RuntimeChildExecution.runSync` also serves existing managed callers through the
shared command runner; only its `spawnNode` operation is the fixed coordinator
control launch. The remaining 23 direct-launch diagnostics are controlled native
test fixtures. Their exact source and launch contracts are reviewed individually in
[the concrete source reviews](structural-review.json); every raw
diagnostic remains visible.

The required follow-up should extend the existing reader, origin and effect
contracts, including intrinsic mutation and actual lower-boundary proofs. It
must not replace unknown provenance with data safety, exempt a helper by name,
or increase the existing work limits. Hardware behavior and unknown analyzer
false negatives remain unconfirmed.

## Superseded v17 qualification and retained reader fixes

The withdrawn v17 OS/reader regression scopes passed 770 tests with no failure or
skip on each pinned Node. Those regressions did not cover the six subsequent
counterexamples and cannot qualify the withdrawn inference or the final analyzer.

The retained reader distinguishes class member names from actual executable
reads and retains computed names, static blocks and getter bodies. New native
environment, global-replacement and native-choice inference from v17 is no
longer adopted. Its twenty native-choice/logical-path cases remain in the
withdrawn patch for future work. The original nullish path omission is covered by
the smaller conservative check, without the withdrawn branch/callable inference.

This does not establish absence of unknown false negatives in the general
analyzer. A passing functional scenario cannot change an incomplete audit to
PASS. macOS and Windows hardware acceptance remains the agreed SKIP, separate
from Linux and mock results.
