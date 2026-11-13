# Portable state migration and source restoration

Managed state is identified by its relative path, regular-file/directory kind,
raw bytes, hash, and captured physical generation. Permission bits, UID/GID, and
ACLs are not ownership evidence. `FileIdentity` is the shared exact bigint
generation codec; the existing real-directory authority API reexports the same
class. A shared `FilePermissionHint` may preserve ancillary copy metadata without
entering a migration fingerprint or authorizing a publication.

## Public migrations

The trusted `migration` invocation policy enters the public migration registry
before ordinary container/runtime initialization. Inspection, dry-run and an
already-current no-op do not create project control directories, stages,
registries, receipts, or Activities. Apply uses the existing
`RepositoryMaintenanceLock` and process-runtime quiescence proof. Captured source,
target, journal and root generations are rechecked under that exclusion.

Layout revision 1 uses snapshot version 3 and journal version 10. The explicit
recovery decoder also handles the exact previous snapshot-2/journal-9 format;
ordinary operation does not silently accept a previous journal. Specs migration
uses fingerprint/journal version 2. A stage is a sibling on the source volume;
the existing `AtomicFile`, `AtomicJsonFile` and `RealDirectoryAuthority` own I/O
and publication. Source, backup and stage are checked at each phase. Native links,
special files, colliding paths, unknown owners and changed generations refuse without
treating process disappearance as authority.

`LayoutFileContent` captures and copies regular files in bounded chunks, validates
the original identity, length and digest again, and publishes only its closed,
read-back AtomicFile stage. Raw before-images live in independent owned evidence
files beside the staging area. The journal binds their physical identities and
digests instead of embedding their payloads. The original Layout regular-file read bound remains in effect; the existing
journal and encoded-snapshot bounds stay unchanged. Individual large files and
aggregate regular-file content are streamed outside the journal. Root metadata
keeps its original read bound and stores raw original/planned payloads through
the same owned evidence API, with compact keys and physical receipts in the
journal. Preflight compares byte lengths, digests and exact generations without
serializing raw root metadata into its comparison. The text planner retains the
existing Node buffer/string bounds.

Permission copy hints remain ancillary: they do not identify a content version
or confer ownership. A failed before-image preparation cleans only payloads with
confirmed publication receipts. A foreign entry or an unconfirmed payload leaves
the complete remaining evidence intact.

Recovery retains every raw before-image until backup deletion, stage cleanup
and final canonical validation have completed. It then atomically publishes a
cleanup-complete or rollback-complete cutoff before retiring its remaining owned
evidence. A publication that reports failure is acknowledged only when its exact
owned stage generation and payload prove that publication actually occurred.
After the cutoff, a later cleanup failure is cleanup-only and does not authorize
canonical replacement or rollback. Cold recovery verifies the receipt-confirmed
canonical tree and planned root metadata, or the restored source and original
metadata, again before deleting any remaining evidence. A competing managed root
or changed bytes/generations preserves the journal and remaining before-images.
Recovery preserves the original, backup and journal whenever it cannot prove
ownership of the next effect.

Configuration conversion uses the normal typed configuration validator, including
plugin validation before plugin IDs select filesystem paths. Unknown shells and
invalid configuration are refused with the original bytes retained.

Root `.gitignore` and `.gitattributes` keep arbitrary original bytes as raw
before-images. Their limited text plan retains the established UTF-8 replacement
decoding behavior, while only the planned bytes must be valid UTF-8. Failed
publication and cold rollback restore the original raw bytes; a foreign edit
refuses without changing the retained journal or adopting another generation.

Before a terminal cutoff, strict readback checks the original-to-planned
transformation using the retained raw payloads. After the cutoff, individual
payloads may already be retired. Cold cleanup still checks the current tree,
root metadata digests and exact generations before retiring any remaining
evidence; it neither restores source nor reissues publication.

## Source representation and capability

`SourceWorkingFile` represents raw regular/missing/directory state and physical
generation. `GitSourceEntry` separately represents the index mode/OID, flags and
Git-observed worktree mode. No domain code infers logical Git mode from native
executable permission bits. `SourceWorkingFileCapture` acquires these facts with
the existing bounded regular-file snapshot APIs.

A repository entry stores its logical `path` separately from its native
`workingPath`. Git can retain a composed index spelling while a filesystem returns
a decomposed name ([Git configuration](https://git-scm.com/docs/git-config/2.40.4#Documentation/git-config.txt-coreprecomposeUnicode)).
The complete index and physical inventories must each pass the
shared portable collision checks. When their spellings differ, the existing
no-follow capture must prove the same kind, raw content and physical generation;
string normalization alone grants no authority. Untracked descendants retain the
proved logical parent and their actual native leaf spelling. Direct Task and
repair readers continue to use the existing bounded reader. Node realpath
resolves links while preserving ordinary requested spelling; it does not discover
the stored Unicode name ([Node 18 source](https://raw.githubusercontent.com/nodejs/node/v18.19.0/lib/fs.js),
[Node 26 source](https://raw.githubusercontent.com/nodejs/node/v26.12.1/lib/fs.js)).

The native spelling belongs to the complete observation and strict wire codec,
while semantic progress uses the stable logical path and content. Before-image
reads and restoration use the captured native spelling. Actual distinct files
with colliding portable names are still refused.

The mutation manifest keeps complete stopped repository observations separately
from semantic mutations. An atomic rewrite to identical bytes is bound to its
observed generation without counting as implementation progress. Recovery retains
that stopped generation and refuses a later same-byte foreign replacement. The
snapshot and manifest share the pure `WorkerArtifactRepositoryEntry` codec and one
entry-difference calculation. Physically enumerated entries must still exist when
captured; an absent indexed descendant beneath an observed regular parent remains
a distinct supported logical state.

Every potential source path is captured before the worker, including raw clean
tracked bytes, dirty bytes and untracked files. The raw before-image is never
reconstructed from an index blob. Limits, unreadable files, unsupported native
types, gitlinks, unmerged modes, inconsistent logical links and independent nested
Git boundaries refuse before launch. Git-tool failure does not select filesystem
authority. Registered main/execution repositories keep their existing distinct
authority scopes.

The source snapshot records HEAD, index, flags, refs, effective configuration,
Git/common directory generations and attribute observations. Named HEAD, index,
common configuration and worktree configuration files also retain their raw hash
and physical generation. This detects same-OID symbolic HEAD switches and
identical-byte control replacements. Ordinary worker and Review Git queries reuse
the existing read-only policy so optional index refreshes cannot create false
control drift. The policy disables optional locks and Git diff's separate automatic
stat refresh through one fixed trusted runtime configuration parameter; it leaves
user configuration files and owned-stage writer policy intact. Git parses this
environment value itself ([Git source](https://raw.githubusercontent.com/git/git/v2.34.1/config.c)),
including on Windows; it is independent of shell quoting. Path-bearing index, flag and EOL output must be valid UTF-8 before
decoding; raw source contents remain binary-safe. Cached attributes
are immutable policy; working-tree attributes are source-owned observations.
This distinction allows `.gitattributes` itself to be restored as raw source while
retaining the immutable index/external-policy checks. The Git `--cached` contract
ignores working-tree attribute files ([Git documentation](https://git-scm.com/docs/git-check-attr)).

`SourceGitRestoreStage` uses an owned `TemporaryPaths` directory and the existing
`GitOwnedStagePolicy`. Its index, objects, refs, configuration, templates and
worktree are independent of the user repository. System/global attributes and
configuration are isolated; owned `info/attributes` disables regeneration. Raw
bytes pass through `hash-object --no-filters`, `update-index --cacheinfo` and
ordinary `checkout-index --prefix`. Raw readback and worktree-observed mode must
match before a capability receipt is bound to the checkpoint.

Owned restore commands explicitly enable `core.longpaths` along with the isolated
EOL/attribute policy. Their internal paths may be longer than the original source
paths; isolating global configuration must not disable this Git for Windows
capability ([Git for Windows](https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html)).
The override belongs only to the owned restore invocation and changes no user
configuration. Linux configuration/readback and long-stage tests do not establish
Windows-native acceptance.

Unconfirmed Git execution retains its owned stage and the existing typed
completion evidence. It does not authorize cleanup, a new execution budget, or
owner reclamation. A confirmed ordinary Git failure can clean its owned stage.

File-backed Git output preserves an original typed process-control failure
through its AtomicFile producer wrapper. The original atomic phase and cleanup
causes remain attached, and the shared primary-cause projection also serves
independent command groups. Mandatory fingerprint output and workspace cleanup
uses the existing completion boundary, preserving the operation failure before
any cleanup failure. These projections retain physical identities, communication
attempts and unknown completion; they grant no retry, new budget or execution.

When a Git producer has no confirmed stop receipt, its AtomicFile output stage,
borrowed descriptor and owned parent workspace remain retained. Closing the
descriptor or deleting that workspace requires confirmed completion rather than
an exception alone. If cleanup fails after a confirmed child exit, failure
aggregation retains the selected typed cause's actual receipt, output and ordered
causes. A different child's receipt cannot establish that cause's completion.

Dispatcher repository fingerprint capture propagates the original typed process
control failure to the shared failure boundary. Execution and call identities,
communication attempts and stop certainty remain available to the existing
diagnostic and guidance codecs. Ordinary repository-content refusals retain
their fingerprint phase; a process-control failure does not become a plain
repository-content refusal or acquire new retry authority.

The public Source repository snapshot and outer checkpoint-authority capture
preserve that same process-control failure without replacing it with an invalid
handoff classification. Failure before Source publication grants no worker or
recovery authority. The ordinary content-policy refusal path is unchanged.

Requirement test execution explicitly selects TAP through the existing shared
Node invocation, because the named-test observation reader consumes TAP. Its
standalone runtime uses the existing external workspace policy; an authenticated
current Flow runtime remains authoritative when present. A typed control failure
retains the exact materialized candidate and its original error for diagnosis.
Candidate cleanup does not infer native completion from an exception.

For `core.filemode=false`, Git-visible mode is retained without promising native
executable bits. A logical `120000` entry represented by a regular file under
`core.symlinks=false` retains its index type and raw link text. Native links are
never recreated. The no-index `/dev/null` operand is Git's cross-platform syntax,
handled before native file lookup, including Windows
([Git source](https://kernel.googlesource.com/pub/scm/git/git/+/refs/tags/v2.50.0/diff-no-index.c)).

## Publication and recovery

Source restoration reuses the existing rollback operation and canonical handoff
engines. Each source publication passes a full current raw/kind/generation/mode
and immutable-control guard. Git output is captured into the shared AtomicFile
closed-stage publication, preserving its verified permission hint. Final readback
checks raw content, kind, Git-visible mode, immutable controls and all paths
outside the authorized mutations.

An operation receipt records its exact native `workingPath`, before/after
representation, physical generation and mode in `prepared` and `published`
phases. One pure selector derives the native target from baseline and stopped
observations plus published directory operations. Both live rollback and canonical
progress validation use that selector, including after an earlier parent-directory
restoration. The prepared receipt is
durable before publication. Recovery acknowledges an already-published exact
generation and resumes only unfinished operations. Same-byte foreign replacements
are refused. Directory effects verify ownership and emptiness; foreign contents
are not recursively removed.

The canonical Store validates the event prefix, plan, mutation membership,
prepared/publication lineage and complete restored path set under its existing
lock before saving an event or settlement. Strict readback repeats those checks.
Source acceptance uses the same settlement-transition validator before comparing
the stopped-worker manifest or confirming a selected result. An incompatible
predecessor therefore retains its original refusal and cannot publish or confirm
an acceptance, even when the attempted settlement binds the latest event digest.
The rollback blob must contain the exact checkpoint baseline before-images.
Initial checkpoint admission and worker-start admission both revalidate captured
physical generations. Changed HEAD/index/config or absent recovery authority
produces a typed integrity stop rather than an automatic Git reset.

A stopped parent does not by itself prove runtime quiescence. A surviving
coordinator may close the registered execution and release its exclusion only
from complete child completion receipts. Source recovery still enters the normal
quiescence and canonical authority checks; runtime closure alone never settles a
source Step or grants a new worker budget.

The handoff authority token is separate from the runtime coordinator token. A
parent that exits without releasing it leaves an abandoned token; runtime closure
does not authorize reclaiming it. Recovery refuses while preserving that token's
bytes and generation, sealed Source evidence and unsettled canonical state.
Normally released ownership permits the existing cold checkpoint recovery and
exact receipt replay without repeating provider or Git effects.

After its terminating response has been durably published, the coordinator closes
its owned native TCP sockets with `destroySoon()`: queued writes complete and the
connection is then destroyed. A peer retaining its write half, including an idle
or incomplete request, cannot keep the released coordinator alive. Actual child
exit and lock release remain required. The retained authenticated mailbox still
replays a lost terminating TCP response after that exit; socket closure confers
no child stop receipt or authority to reclaim an owner.

The selected source scopes remain the execution checkout and its active canonical
Version. A linked worktree records its Git directory and shared configuration/refs;
this does not add authority over the entire main checkout.

Task Review can exclude independently cataloged execution observations only with
the existing typed append provenance captured in the same canonical view.
Publication revalidates that provenance in its current locked view. Current
missing paths require an explicit source selector exclusion; an earlier retained
observation may predate a newly approved immutable append. Present bytes and
ancestor kinds remain checked. Stored observations remain complete, and ordinary
source paths retain full generation checks. Reconciliation excludes only its
actual canonical Version from the adopted source snapshot because its own
approved transaction replaces those records; state, catalog and retry bindings
continue to validate that canonical lineage. Unrelated Specs and worktree shadow
paths remain source observations. Recovery publication compares the full stored
repository observation rather than its semantic progress digest.

## Persisted formats and consumers

The Flow schema revision is 5; repair fingerprint format is 4. Source snapshots,
baselines, mutation manifests, rollback blobs, checkpoints, events, settlements
and rollback plans use source-state version 2. `SourceRestoreCapability` and
`SourceRollbackOperationReceipt` use their own version 1 contracts. Ordinary
readers accept only the current exact field sets and hashes.

Task source snapshots use version 2. Each present file carries its raw digest
separately from UTF-8 presentation. The current-source fingerprint and repair
carry comparison use that digest, so different invalid-UTF-8 byte sequences cannot
collide through replacement characters. One strict snapshot decoder owns
persisted workunit readback; Review may still certify pre-review edits it actually
observed.

Stored digest fields are mandatory. Strict roundtrip checks reject nested fields
that a constructor would otherwise omit, normalize or default; mutation IDs must
match the existing Attempt/path identity algorithm.

`sennel migrate specs --to 5` explicitly projects revision 4 through the public
transaction. It retains Activities, Attempt identity/sequence, catalog references
and semantic results, and archives original hash-bound input. Records lacking old
physical/raw authority refuse unchanged. Active old repair/retry/reconciliation
authority cannot gain fresh execution rights from a changed fingerprint algorithm.
Immutable historical records may be retained only where their existing consumer
does not hydrate them as current execution authority. Earlier public revisions
remain explicit migration routes, without ordinary-reader compatibility fallback.

Implementation and Task repair history, reconciliation, retry, execution
observations, source handoff persistence and query detail share the current typed
codecs. Steps still determine results; Definitions retain route, retry and
settlement policy. This migration does not resume a stopped Flow.

## Validation boundaries

Linux acceptance uses pinned Node 18.19.0 and Node 26.12.1. macOS/Windows hardware acceptance is
explicitly unperformed for this change; Linux or mock success is not hardware
evidence for those systems. The shared filesystem and Git APIs supply the same
contract on all three platforms, with unsupported source representations refused
before worker launch.

The task evidence records exact source/test hashes, authentic predecessor-producer
fixtures, same-input regression comparisons, durable recovery, phase downstream
scenarios and real-agent verification. Structural analysis must report incomplete
results as incomplete; filtering, baselines, fixture scopes and raised analysis
budgets do not establish production acceptance.

The user revised e799's completion scope on 2026-11-07: functional migration,
Source recovery, downstream consumers, required regressions, Draft/Spec scenarios,
real-agent checks and final integration remain required. General analyzer
limitations and false positives are tracked separately in
[the structural audit handoff](structure-audit-handoff.md). This does not waive
actual OS, safety, common-API, duplication or consumer defects in e799, or a false
PASS introduced by an adopted checker change. The whole audit remains incomplete
and does not satisfy the earlier, broader structural completion condition.

## Runtime transfer during validation

Owned Node children and Workers share the already captured runtime's compressed
representation. Each delivery keeps its own physical authority, compressed byte
digest, exact decoded byte bound, revision check, acknowledgement and confirmed
cleanup. The builtin-only bootstrap checks the compressed file before bounded
decompression and installs the existing fixed loader. Direct child delivery
retains its existing capacity; the RPC representation separately retains its
32 MiB decoded ceiling. Compression uses Node's common zlib API on all supported
platforms and adds no external command or dependency.

The isolated comparison retains complete Source snapshot JSON, including raw
file and Git facts and physical generations. Existing semantic validation is
reused only for unchanged source, migration, recovery and publication contracts;
it is not presented as validation of the new transport. Actual child, Worker,
runtime RPC, read-only Git, failure retention and cleanup cases exercise the new
transport on the minimum and Current Node versions. A measured runtime-history cache
candidate was rejected because it did not improve repeated-read speed.

Parent Task Review baseline and manifest capture each reuse one existing
read-only managed process scope for the complete Source observation. Current or
inherited execution authority continues through the common scope API. Every Git
query still uses its existing command adapter, result, stop receipt and canonical
event drain. The manifest's coherent canonical-view callback remains synchronous;
scope acquisition precedes that callback and completion follows it. Existing
scope closure and failed-callback diagnostic retention apply without a new owner,
pool, event publisher or execution protocol.


## Query, preflight and process evidence boundaries

Task Review reconciliation input validation and the public next-action projection
use the existing explicit read-only managed scope. Their external Git reads keep
typed results and stop receipts in that owned scratch scope. A prelaunch input
refusal leaves canonical Activities, catalog, Attempt and retry budget unchanged.
The canonical projection and coherent-view callbacks retain their synchronous
contract. Process control failures propagate as their typed failures.

Flow stop readback selects the requested canonical checkout namespace through
`ProcessExecutionRuntime.inspect`, including committed receipts from active and
closed executions and the inspector's existing archive readback. Ambient scratch
receipts belong to their own namespace. A committed child receipt proves that
call's closed execution subtree; root quiescence remains a separate check through
the existing runtime authority.

Context reads have an established metric side effect. Their explicit registry
`readOnly` metadata controls both CLI storage selection and the existing Flow
runtime admission classifier. Inherited execution authority is authenticated
before metric publication. The existing metric writer persists the same Activity
and leaves the active Attempt and budgets unchanged. Pure status, next-action and
help retain inspection storage and unchanged canonical/project state.

Canonical worker observation guards compare the complete observed file records
through the existing snapshot API. An identical-byte foreign replacement of an
existing fact or protected semantic artifact is refused by its physical generation;
permission hints remain ancillary and grant no authority. Authenticated new
observation appends and selected canonical publications retain their existing
exact-path exemptions.

Dispatch checkpoint admission rejects an already unrelated canonical Activity
advance before repository probes can publish process observations. It reconstructs
the authenticated execution allowances and reuses the existing exact Activity
prefix predicate. The complete repository comparisons and final canonical
after-image validation still run before accepting the checkpoint.

Source restore uses the existing synchronous managed-completion boundary for
both operation failure and mandatory stage disposal. If both fail, the returned
error retains the original failure first and the cleanup failure as a second
cause, including typed process-control semantics. The combined error message
also retains both causes for saved diagnostics. Successful cleanup never replaces
the original failure. Retained stages and source publication guards
keep their existing ownership and generation checks.

The associated regressions retain exact before/after test bytes: canonical
same-byte refusal, canonical receipt namespace selection, and Context metric
publication. The performance evidence is representative and establishes no
whole-suite speed claim. Original long-running failures and their complete
parents remain recorded. The corrected per-case real-agent watchdogs and exact
scoped qualifications are described below; neither failed whole official command
is reported as passing.

Canonical finding source lookup retains newest-first producer selection on the
minimum and Current Node versions. It reverses a copy of the retained payload
array, preserving source bytes, stored payload order and exact finding identity
across repeated reads. This changes no artifact codec or migration contract.

Requirement Review checks retained Gate blockers through the existing typed
`ReviewEvidence.disposition.blockingFindings` API. Promotion preserves the exact
Gate fingerprint without duplicating it or rewriting the sealed worker bytes.

Borrowed Flow execution keeps its authenticated grant, immutable binding and call
admission, but receives no canonical process-event writer. Only the owning
runtime drains and acknowledges process events. This also covers deferred catalog
publication and borrowed close; the coordinator continues rejecting borrowed ACK
and root-capability forgery. Context's existing metric observation may commit
without advancing the Attempt or budgets, and the parent later publishes every
registered child event and its exact stop receipt through the existing writer.

## Runtime validation and structural inspection

Runtime record validation retains every call, event, acknowledgement, lineage,
receipt and finalization check. Local call/event indexes replace repeated linear
lookups within one validation. The common descendant traversal preserves breadth
first order and the original sibling order. These indexes are rebuilt for the
current inventory and do not carry authority across changes. Runtime storage
uses revision 10 with the independently versioned evidence contracts below.

Shared source inspection distinguishes syntax from string/member data and keeps
nested class declarations with their captured caller environment. Only primitive
evaluations that emit no source observations reuse work, within the same module,
environment and inspection mode. Unknown capabilities, definition-time effects
and exhausted finite work remain incomplete. The recovery rule follows the
actual runtime-admitted continuation and rejects shadowed or discarded results.

The unfiltered integrated OS inspection remains incomplete. Its diagnostics are
retained alongside the passing focused regressions and phase structural checks;
no baseline, exclusion or larger analysis budget converts that result to PASS.
Functional runtime acceptance and structural inspection have separate evidence.
A passing scenario does not turn an incomplete source audit into PASS.

The additional native environment, metadata and invocation inference attempted
during integration was withdrawn after six native-intrinsic mutation programs
falsely passed. The counterexamples and withdrawal result are recorded in the audit handoff. Unsupported normal program shapes remain
incomplete; no baseline count or exclusion changes their result. The retained
logical path check is conservative and grants no invocation authority.

Service inspection follows `new this()` in a resolved static factory through
the actual calling class's instance constructor, initializers and observed
instance members. Inherited factories retain the derived class receiver.
Only a directly bound static call supplies that receiver; detached methods and
explicit rebinding remain unresolved instead of borrowing another call's proof.
An unproved receiver in another callable or an instance method remains a
diagnostic; no helper module or class name is exempted from inspection.

Publication preparation retains the existing immutable observation provenance when
creating mutable record shells. It reuses a nested fact only while that exact
field still belongs to its frozen source. All mutable containers, normalized
scalars and current graph relationships are rebuilt and checked. Context-bound
control failures always pass through their existing identity-aware decoder. Raw
file readers, physical observation, checksum, capacity, transition and readback
checks retain their existing contracts. The new native regression verifies that
changing a call or execution identity refuses before any physical mutation and
that the original reservation can still close normally.

## Exact process identities and non-growing failure confirmation

Current checkout authority stores all four device/inode values as canonical
signed decimal strings, using the existing `FileIdentity`. Capture retains the
native bigint values without converting them to Number. Current runtime records
use revision 10, stop receipts 4, reservation revocations 3, control failures 3,
communication diagnostics 2, non-execution evidence 2, saved recovery summaries 4
and execution-source manifests 2. The Flow lifecycle state remains schema 5;
these leaf formats own their separate revisions.

Communication keeps its typed `unknown`/`confirmed` semantics. Its wire boolean
`stopConfirmed` changes from `false` to `true`, shrinking by one UTF-8 byte.
Confirmation retains the original message, cause, context and every attempt.
The 16 KiB failure bound and 16 MiB physical record bound remain unchanged.
Terminal-capacity calculation uses the same non-growing encoding; it does not
invent a confirmation or increase the control/close budget.

A current receipt, revocation, non-execution observation or saved recovery
summary can explicitly retain a previous producer's
safe numeric checkout tokens as evidence. Their semantic checkout is exact
`FileIdentity` data; those numeric tokens never become current native authority.
The current leaf version rejects the old leaf version. `evidenceDigest` identifies
the original producer fact by reconstructing its original encoding. Normal
content/file hashes still cover the actual current bytes. Closure references,
parent/descendant membership, result-finalized events and existing canonical ACKs
therefore retain their original identities. Migration never reissues an event or
claims a new canonical publication. Fresh native facts use decimal-string wire
identities and their own current evidence digest.

`sennel migrate runtime --to 10 --execution-root <checkout> --dry-run` inspects
one exact revision-8 or revision-9 namespace. Explicit apply requires closed
executions, complete original requests and released ownership. The common chain
decoder and current planner own validation and physical encoding. Anchor
conversion and retirement of replaced request blocks belong to the same prepared
migration, including exact source generations and staged before-images. Only the
typed migration plan may replace an anchor or retire a block; ordinary result
publication and data recovery have no such authority. Interrupted publication
requires explicit `--recover` and never restarts operations or adopts old grants.
An earlier selected result/journal that cannot be decoded by the current migration
is refused and retained; this does not authorize recovery with unproved code or
reclamation of an old worker.

When required, runtime migration precedes canonical Specs evidence migration.
`sennel migrate specs --to 6 --spec <specId> --dry-run` previews source-manifest
and Prompt evidence conversion through the existing root transaction. Specs
revision 5 also performs that evidence conversion while projecting Flow schema 4
to 5. Revision 6 keeps Flow state and Activity bytes unchanged, archives each
changed original artifact and its hash, and records source/target hashes. Source
registration IDs, process event identities and original closure references remain
bound to their actual producer. Prompt document links use the existing Flow
stable-digest API with an explicit typed producer-evidence projection. Their
original record IDs, recovery-summary IDs and predecessor links remain unchanged;
the catalog checksum separately covers the actual current bytes. The projection
owns only process Stops, reservation calls and saved recovery observations, and
never searches opaque provider output, invocation or binding values.

Normal Store reads and transactions reject old source contracts before appending
facts. Missing lock directories use the existing initial-format preflight, so a
format refusal does not create control directories. The locked path repeats the
normal current-contract checks. Historical started-process and physical-consumption evidence remains bound to
its registered immutable source. An unstarted canonical reservation continuation
may legitimately precede physical source publication; its typed proof still
requires exact contract, summary, call inventory and saved checkout agreement.
Historical readback grants no execution authority, and live admission still
compares the current checkout.

An unresolved original pending reservation is refused rather than acquiring a
fresh proof or budget. A pending marker retained in an immutable ancestor event
may be converted only when the same scope's authoritative frontier and complete
original predecessor chain prove that exact marker was consumed. Each consumed
ancestor is reconstructed with its original flat history prefix and identity. A
missing, conflicting, cyclic, unrelated or stale pending frontier cannot supply
that proof. Opaque invocation data, provider responses, bindings and old grants
are never recursively rewritten as if they were evidence schemas.

The immutable revision-9 producer fixture contains only the original package and
source resources, captured before this repair. Native tests launch that original
producer through its own bootstrap, observe real registered parent/child exits,
record an actual unlaunched revocation and preserve real durable event ACKs. The
canonical data fixture was produced through the original Prompt admission with a
native local Node provider, and contains no physical runtime ownership. Its
original checkout coordinates are never rebased. Minimum/Current Node tests must
verify read-only refusal/preview, explicit apply, interrupted-publication recovery,
strict current readback and actual saved-response/budget consumption. These local
provider checks are separate from external AI acceptance.


Specs evidence migration handles hash-bound previous receipts only through an
explicitly validated original producer graph, after the retained runtime has been
migrated. The graph binds the actual original completion to its execution contract
and Activity, the immutable Spec snapshot where applicable, and the complete
settled Source authority. Replacing only an embedded receipt would invalidate the
artifact hashes and sealed publication inputs, so migration retains the original
Flow and producer artifact bytes and hashes. It adds permanent per-receipt current
encoding proofs through the existing root transaction instead.

The owning catalog verifies the required proof artifacts before decoding an old
receipt. Value objects and Services receive the acquired pure encoding; they do
not inspect runtime storage or infer a fallback. Fresh live receipts still use
schema version 4, and an unproven bare version-3 receipt remains unsupported. A
retained typed receipt preserves its original producer serialization and digest
when written back to a hash-bound artifact.

A missing or inconsistent producer graph is refused with `UNSAFE_SOURCE_FORMAT`.
An unfinished previous Source handoff is also refused: migrating its historical
runtime does not authorize output reuse or execution in another runtime. Original
producer bytes remain unchanged. Successful migration supports strict current
readback and the already authorized downstream consumer; it does not resume a Flow
or grant new execution or recovery authority.

## Bounded capture and completed freeze proofs

The shared artifact catalog groups declared content with an internal 8 MiB
target. A larger valid individual artifact still uses the existing per-file
limit. Each batch acquires fresh direct-parent authorities and reuses the common
`RegularFileSnapshotGroup.capture` forward/reverse forest before semantic
validation. Siblings share their captured parent within that batch. No live
directory authority or file-content cache survives into a later capture. The
existing activity-index cache accepts only newly physically captured and
hash-verified ledger bytes. Expected catalog-size failures retain the original
content-mismatch error, and typed identity/control failures remain unchanged.

The shared `freezeExecutionValue` stores completed own-data graph proofs in two
weak generations, rotating each after 16,384 enrollments. Expiration triggers a
complete traversal. A per-traversal map distinguishes active cycles from completed
aliases, including aliases whose global proof expires during the traversal.
Arrays and class instances keep their identities. Accessors and proxies are
observed on each call; this cache grants no physical or execution authority.

Parent Source manifest capture and sealing preserve the original nominal
`ProcessExecutionControlFailure` before the common failure-selection boundary.
Regressions cover its exact identity, saved worker-exited checkpoint, pending
settlement and current source bytes/generation. The test publication observer
also releases unrelated mock recorder history after each observed call while
retaining its authenticated publication/readback observations. A separate native
WeakRef regression qualifies that bounded test instrumentation; it does not prove
the attribution of an earlier whole-parent heap failure.

## Current validation evidence and limits

The original Node 18 Draft/Spec scopes have 18 qualified positive results,
including the shared strict-stop seed and downstream consumers. The original
Node 18 Source policy parent passes all five roles and its parent contract.
Both pinned Nodes pass 349 current shared/catalog/migration cases each and the
original native-16 workload, retaining all 16 children, 64 canonical events,
receipts, cold readback, actual coordinator exit and lock release. Saved input
hashes qualify reuse across the sole unconsumed real-agent watchdog delta.

All 14 required original real-agent cases have positive results on each pin,
through source-identical scoped reuse: 13 plus the corrected Task case on
Node 26, and 12 plus the missing Task/Spec cases on Node 18. The literal whole
Node 26 command exited 1 after the old Task case watchdog canceled. The literal
whole Node 18 command exited 1 at the existing 3,600,000 ms category cutoff.
Both full-command failures remain recorded. Original opt-in skips remain skips.
The qualified union establishes the selected contracts and does not claim that
either whole `npm run test:agent` command passed.

The other three original worker cases retain 480,000 ms watchdogs. The Task
review/repair/re-review case uses 1,920,000 ms, and their suite uses 3,360,000 ms.
The Task limit covers its three sequential original calls, two originally
permitted attempts per call at 240,000 ms, plus the existing 480,000 ms fixture
and readback allowance. Provider limits, retry settings, bodies and assertions
are unchanged. Native scaled timer regressions on both pins distinguish valid
sequential work from provider or case expiry. Treating the former aggregate
480,000 ms suite limit as immutable was an agent-added restriction, corrected
after reading the actual user instructions. Analyzer budgets were not raised.

The full unit run retains two existing static expectation failures after the
source-copy input omissions were corrected and rechecked: a fixed result-class
inventory and the legacy-name scanner's required migration identities. No
expectation, skip or allowlist was changed to hide those failures. There is no
whole-unit PASS claim. The current raw structural audit remains NOT_PASS as
recorded in the linked handoff. Native macOS/Windows hardware validation remains
the agreed SKIP, and generated-doc freshness remains indeterminate because its
cached analysis refers to the deleted offline migration module.

The committed [validation summary](validation-summary.json) records the exact
source identity, nine requirements, qualified case sets, native outcomes and
known limitations. The complete structural report and concrete reviews are linked
from [the audit handoff](structure-audit-handoff.md). Temporary runtime namespaces,
working copies and transcripts are retired after main inclusion is verified, as
requested by the user. Their historical failure outcomes remain recorded; retired
state supplies no execution or recovery authority. A server restart removed one
terminal tool handle; the original surviving observer and controller persisted
actual owning `wait` results without restarting that scope or inventing a receipt.
