# Portable file foundation

Managed storage uses `RealDirectoryAuthority`, `captureRegularFile`,
`AtomicFile`/`AtomicJsonFile`, and the operations in `regular-file-io.js`.
Callers retain their domain decisions about ownership, receipts, execution,
migration and recovery. These primitives validate physical storage; they do not
grant permission to run a Flow or establish a process owner.

Directory authorities pin the exact device/inode identity of every ancestor,
reject symbolic links and noncanonical spelling, and revalidate around I/O.
Readers validate the visible file, open descriptor, bounded bytes, completed
descriptor and visible name, then close the descriptor. Identity uses exact
bigint values. A caller's explicit byte budget is preserved; previously
unbounded in-memory consumers use the current runtime's finite Buffer capacity.

Directory observations use numeric `lstat` only when both native identity fields
are nonnegative safe integers, then convert those exact integers to bigint.
Otherwise a fresh bigint `lstat` validates the kind and identity together.
Disappearance or a changed kind during that fallback refuses the operation.
Every check still observes the complete pinned ancestor chain; no physical
stability result is cached. The one-time canonical spelling proof is retained
only while those freshly observed identities remain equal.

Callers pass the retained parent authority into later file operations. Ensuring
a directory and then resolving it again would adopt a replacement between the
two operations. Version catalog publication carries the same authority through
lock namespace creation and transaction journal access; runtime metadata uses
the already locked runtime authority. Typed Flow writers retain the Location's
repository authority and, inside a Store, its previously captured Version
authority. Temporary agent inputs carry their minted directory authority through
creation, capture, later byte checks and cleanup. Plugin enumeration retains
source parents, and copying retains each ensured destination parent.
Runtime child delivery uses `TemporaryPaths.createOwnedDirectory()` so the
ensured parent authority reaches child allocation, descriptor publication and
owned cleanup without resolving the parent again.

Atomic writers create an exclusive stage beside the destination, write and
flush all bytes, close it, and bind its identity and digest. Publication checks
the old destination and pinned directory again after the commit guard, then
renames and reads back the result. A tool may explicitly adopt and seal a stage
once; publication never silently reseals modified bytes. Existing exclusive
owner publication uses the same stage with a non-overwriting link operation.
This preserves the lock owner's existing protocol.

The default stage remains 0600. Copying may explicitly supply a
`FilePermissionHint` captured with the source descriptor's completed stat. The
writer applies it before writing, matching native copy ordering, then seals the
actual post-write metadata with its bytes. POSIX executable and ordinary access
bits are preserved; native writes may clear setuid/setgid. Windows uses Node's
writability semantics. Neither the hint nor its comparison proves ownership or
ACL privacy, and transaction images do not serialize it.

`createOutputStage()` lends its exclusive stage descriptor to a synchronous
producer, then flushes/closes and seals it with a streaming receipt. Publication
also verifies that receipt by streaming, so large tool output remains off the
process heap. The producer's command and process-result meaning remain with its
caller; this API does not confer execution authority.

Failures distinguish a refusal before publication, arrival at the visible name,
an unconfirmed publication, and cleanup errors. Only the operation's minted
stage may be cleaned. Append reports partial or unconfirmed bytes and never
retries or rolls them back. Closed-descriptor removal checks identity, bytes and
the expected link count before unlinking.

These are observed identity and exact-byte guarantees, not protection against
every adversarial concurrent filesystem-tree mutation. Directory fsync,
power-loss durability and atomicity across multiple renames are outside the
contract. Permission arguments preserve Node's metadata hints; they are never
identity or ownership evidence. In particular, Windows chmod does not provide
POSIX access permissions or establish a private ACL.

## Temporary storage and paths

Normal scratch belongs to the selected project/shared repository's canonical
`.tmp`, through `TemporaryPaths`. Namespace resolution and validation do not
create directories. An `OwnedTemporaryDirectory` retains the authority minted
at creation; a path alone cannot reconstruct that capability.

`ReadOnlyInvocationWorkspace.create()` mints a unique child of Node's canonical
temporary directory. Its generation and pinned authorities cannot be restored
from a caller-supplied path. Resource-tracking tokens grant no execution
authority. Pending execution evidence survives until the caller confirms normal
exit and released resources for that generation. Released nested directories
are retired through the workspace's cleanup API; missing or replaced paths are
not adopted. The workspace is never canonical state or a resume registry.

`LogicalRelativePath` and `LogicalPathSet` enforce the same stored-name grammar
on every host, including reserved names, case/Unicode aliases and file-prefix
conflicts. `NativeAbsolutePath` performs physical containment and authority
checks at conversion. Existing boundary converters may normalize their declared
external input before constructing a logical value; stored names are not
rewritten for a particular OS. Log masking checks native segment boundaries.
Every absolute reference in compound log text needs its own trusted root, even
when the text starts with a trusted path. Known-root spaces and punctuation are
retained; ambiguous external spans are conservatively masked. URL tokens retain
their URL meaning after credential masking.

## Transaction image revision 2 and old journals

`FileTreeImage` stores revision, kind, logical path, exact bytes, byte length,
per-file digest and image hash. It has no mode compatibility branch.
`VersionTreeSnapshot` produces this image and retains the baseline catalog
until the last restore publication. Strict reload validates the image even when
the visible catalog appears to have committed. Unknown catalog identity,
corrupt hashes, unaccounted hard links or an unsupported image revision remain
refusals, with the journal retained.

The current catalog journal requires a `rollbackBlocked` boolean. A directory
authority refusal during writing or rollback records this flag before abandoning
the transaction. Same-process and fresh readers refuse that journal before
reconstructing the snapshot: a new traversal cannot authorize deletion of a
directory already rejected by the operation. Original directories and the
journal require explicit investigation. If recording the flag fails, the error
retains both failures and does not claim a durable refusal record. Ordinary
interrupted rollback without an authority refusal remains recoverable.
Directory deletion and movement classify a recreated source name, a changed
destination identity, or an unavailable source readback as an authority refusal.
The operation error retains its visible-but-unconfirmed status and the refusal
through its cause, so rollback cannot lose that decision before journal recovery.

An unfinished revision-1 catalog transaction must be recovered with the exact
original producing release before using this release. Preserve an external
copy of the entire Version directory, including `.runtime/catalog-transaction.json`,
and any existing backup first. With that producing release, open the selected
Version through its ordinary catalog reader to perform its transaction recovery;
confirm a coherent catalog and the removal of its journal before upgrading.
If the original producer cannot validate/recover it, retain the original and
backup for explicit investigation. Do not delete the journal, edit its revision,
or treat partly published bytes as successful recovery. The new codec refuses
this format rather than guessing a conversion or invoking the unrelated
layout/specs migration commands.

The immutable fixture in `tests/fixtures/version-transaction-v1` was captured
from the actual previous producer. Its provenance records the producing commit
and SHA256, and tests assert preservation of the original journal, state and
backup on refusal.

## Verification boundary

The same physical-contract tests must run on real Linux, macOS and Windows
with Node 18.19.0 and supported current. Mocked branches and lexical drive/UNC
tests are additional boundary evidence, not substitutes for those executions.
The full source audit remains nonzero when it reports violations or incomplete
analysis; diagnostic classification does not turn that result into a pass.
