# Git plugin archive installation

Board `c24c` replaces external `tar` extraction while retaining Git's archive
semantics. The baseline is `62eeacaa104f626747c14b50a149e62362c4c838`;
implementation and verification were performed on branch `codex/c24c` in a
dedicated worktree. Verification evidence is retained under the repository root
when that worktree is removed after merging.

## Input and publication contract

`PluginSourceStore` resolves a commit once. Git sources use the existing
`runGitToFile()` and ordinary `GitRepositoryPolicy` to produce
`git archive --format=tar <commit>`. Attributes remain Git's responsibility:
`export-ignore`, `export-subst`, Unicode/long-path PAX records and the global
commit comment retain their original meaning. No raw-blob replacement, shell,
external archive extractor, or extraction fallback is used.

`GitPluginArchive` accepts only bounded Git-generated ustar/PAX input. Its value
classes validate header checksums, octal fields, UTF-8 byte lengths, PAX framing
and effective path/size overrides, padding and two terminating zero blocks.
The default ceilings are 256 MiB for the archive, 64 MiB per payload, 256 MiB
total payload and 10,000 headers including PAX metadata. Input is captured as
immutable bytes before validation; it is never reread during extraction.

Only regular files and directories are supported. The complete write set is
checked before extraction. `LogicalRelativePath`/`LogicalPathSet` reject
traversal, unrepresentable names, duplicate entries, case/Unicode aliases and
file/directory prefix conflicts. Links, special types and unsupported extensions
are refused, including entries outside the package's install allowlist.

Extraction uses owned `TemporaryPaths` directories, retained
`RealDirectoryAuthority` chains, `NativeAbsolutePath`, `AtomicFile` and
`FilePermissionHint`. The existing directory-retention helper is shared with
registry copy operations rather than duplicated. File bytes and ordinary
permission hints are preserved; archive uid/gid/device ownership is never
reproduced. On Windows, permission hints use the existing writability contract.
Directory permissions are creation hints, subject to the native filesystem and
umask, and do not confer ownership or privacy.

The existing `PluginManifest`, source validation and copy plan feed exactly one
`PluginInstallation`/`PluginInstaller`/`PluginConfigTransaction`. Materialization
cleanup occurs after copying into the install stage and before publication.
Validation, swap, config and installed-readback failures roll back the existing
package/config. Readback retains and rechecks the installed directory identity
before deleting the original backup and before returning success.

Cleanup and rollback failures retain their primary causes. If recursive backup
deletion has begun or publication cannot be verified, installation fails and
preserves available trees/backup evidence instead of claiming exact restoration.
There is no new journal, process-loss resume protocol or retry engine.

## Git sources and platforms

Local Git probes use the existing read-only policy, so inspection does not create
runtime artifacts in the source or make a clean source dirty. Non-Git local
sources retain their materialized path and need no Git invocation for installation.

Remote cache operations place execution-control storage at the project root,
outside the tree that `git clean` owns. Cloning defers checkout; the owned cache
enables `core.longpaths` before checking out the selected commit. Source checkout
failure stops immediately without cloning again or resolving a mutable ref twice.
This changes neither the global Git environment policy nor user source config.

The reader/extractor has the same implementation on Linux, macOS and Windows.
Native filesystem, path, permissions, atomic publication and runtime/stop
differences remain in the existing shared modules. Git remains the existing
required external tool for Git sources; remote transport credentials and transport
helpers remain Git prerequisites.

The API prerequisites were checked against [Node filesystem documentation](https://nodejs.org/docs/latest-v18.x/api/fs.html),
[Git archive attributes](https://git-scm.com/docs/git-archive#_attributes) and
[Git for Windows long-path support](https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html).
The package minimum is Node 18.19.0. The tested Current release was selected from
the [Node release list](https://nodejs.org/en/about/previous-releases).

## Acceptance evidence

The repository's `.tmp/c24c/` retains the board snapshot (`request.md`), starting
state (`start.json`), exact source/test SHA-256 hashes (`verification-source.json`),
test output and official-repository checks. `verification-results.json` records
the exact commands, Node executable hashes, results and native-OS skips.
The downloaded verification toolchains are removed after testing; reacquire
the recorded Node versions to repeat the cross-version commands.
The OS audit is retained in full and
is not counted as passing when incomplete.
When cleaning up the development worktree, this evidence is relocated to the
main checkout's `.tmp/c24c/`; historical command paths retain their original
worktree spelling.

| Observable outcome | Verification |
| --- | --- |
| Valid Git/PAX binary, Unicode, long-path and export attributes | `git-plugin-archive.test.js` in unit and integration suites |
| Corruption, bounds, links/types, global/local effective paths and aliases refused before writes | Archive unit contracts and malformed-input integration |
| Created/replaced stage identities retained | Archive and installer replacement regressions |
| Local Git, pinned sync, update, remote fixed commit and non-Git input | `plugin-archive-install.test.js` integration |
| Copy/validation/swap/config failure restores package/config | Existing `plugin-install-transaction.test.js` |
| Materialization cleanup/manifest failures preserve causes/input and old publication | Public archive-install integration |
| Readback, cleanup, partial deletion and conflicting rollback preserve recoverable state | `plugin-installer-recovery.test.js` |
| Unknown remote cleanup result does not trigger clone/ref retry | Public archive-install integration |
| No external tar or host shell on PATH; installed contribution actually executes | `plugin-archive-install.test.js` E2E |
| Existing copy, hook, config and executable consumers | Related plugin integration/unit tests |
| Real official repository at clean HEAD, all preset contribution paths, downstream chain/template read | `verify-official.mjs` and `official-node*.json` evidence |

Before the P2 review follow-up below, the public/recovery/consumer/structure batch passed **117/117**
tests on each Linux Node version (`node18-public-recovery.log` and
`node26-public-recovery.log`). The archive/transaction/CLI batch passes **38/38**
on each version, recorded in `node*-contracts-final.log`: **155 tests per
version, 310 total, no failures or skips**. The official source is clean commit
`31bdd70fecfcde33c32bd75909218b744561c24e`; both versions install and read all
**35** preset contribution paths and resolve `base → cli → node-cli`, including
an installed template read. These are real repository/file/Git operations.

Regressions were compared without changing their inputs/assertions: the starting
installer fails five of the original ten recovery cases; final code passes them.
Those failures include loss of the primary error during staging cleanup,
partial backup deletion and replacement-directory handling. The two subsequently
added readback/cleanup-hook replacement cases both fail before their product fix
and pass afterward. The archive child-directory replacement case similarly
fails before retaining descendant authorities and passes after the shared-helper
change. Injected fault checkpoints demonstrate transaction boundaries; they do
not claim OS-crash or native ACL coverage.

Linux ARM64 runs use Node 18.19.0 and 26.12.1; download checksums are retained.
macOS/Windows real-host acceptance, including ACL and permission denial, is
**skipped/unverified**, as agreed in the board's 2026-10-21 acceptance policy.
Linux results and simulated boundary cases do not count as real-host passes for
those systems. No mandatory follow-up acceptance is assigned to board `3137`.

The initial implementation's full-product OS audit is **incomplete**, not PASS. The isolated starting-HEAD
audit inspected 1,110 files and reported 31 violations / 1,826 incomplete
diagnostics; the final audit inspected 1,112 files and reported the same 31
violations / 1,844 incomplete diagnostics. Comparison by rule, file, message and
classification found no added violation. Raw reports and the diagnostic
comparison remain in `os-audit-{baseline-final,final}.log` and
`os-audit-comparison.json`; no checker exclusions, skips or expected results
were changed. This is not evidence of a complete source audit.

New incomplete diagnostics concern static evaluation limits/capability tracing
in the archive reader and retained-authority helper, plus the installer's mutable
backup state. Manual review traced these to the shared path/directory/file
boundaries, and the focused structure suite exercises its positive/negative
contracts. This review and Linux execution do not resolve the full-product
checker's limitations or establish real-host macOS/Windows acceptance. The
existing full-product guard work remains outside this board's implementation.

## P2 review follow-up: cleanup after an authority refusal

The review correctly identified two outer cleanup paths that could discard a
detected ownership refusal. Archive extraction retains descendant identities,
but the materialization owner retains only its temporary/package roots. Its
recursive cleanup could therefore remove a replaced descendant after extraction
had already refused it. Similarly, an incomplete copy could fail before the
installer captured `stagingAuthority`, allowing its failure cleanup to adopt a
replacement stage by reading the path again.

Both paths now reuse `RealDirectoryAuthority.isAuthorityFailure()` to classify
genuine authority refusals, including causes nested in `AggregateError`.
Materialization records that cleanup has been attempted and refuses recursive
deletion after such a failure; a later `finally` cannot retry by reading fresh
path identities. The installer selects its existing uncertain-recovery branch
before reconstructing or removing package directories. Available stage,
replacement, original and backup trees remain intact; the operation still fails
with its original cause. Independent config rollback keeps its existing byte
revision guards. Ordinary copy/validation failures retain their cleanup behavior.
No common filesystem/runtime API or platform contract changes.

The frozen five-case regression set covers actual archive extraction and
production copying through public install APIs, direct stage-root replacement,
wrapped nested-directory refusal, and ordinary partial-copy cleanup. In an
isolated copy of the pre-P2 product, the four replacement-preservation cases
fail and the ordinary-cleanup control passes. With the same inputs/assertions,
all five pass after the fix. Original and replacement bytes and unchanged
published package/config are asserted, rather than only testing that execution
throws. A normal archive refusal also asserts that owned temporary files are
removed.

`p2-regressions-{before,after}.log`, `p2-baseline-location.json`,
`p2-before-product/` and `p2-verification-source.json` preserve this comparison
and its product/test hashes. The earlier `verification-source.json` and
`verification-results.json` describe the pre-P2 acceptance run; they are retained
as historical evidence, not rewritten to claim the new source was tested then.
The affected public install, recovery, existing transaction and CLI tests pass
**36/36** on each Linux Node version (18.19.0 and 26.12.1), **72 total**, with
no failures or skips. Commands, executable/log hashes and source fingerprints
are recorded in `p2-verification-results.json`; the incremental product change
is separately reviewable in `p2-product.patch`.

The full-product audit was rerun for P2: 1,112 observed files, the same 31
reported violations and 1,844 incomplete diagnostics, with no new diagnostic
compared with the pre-P2 audit. It remains **incomplete**, not PASS; see
`p2-os-audit.log` and `p2-os-audit-comparison.json`. The agreed real-host
macOS/Windows skips remain unchanged.

Draft/Spec behavior, agent invocation and generated skills/presets are unchanged;
phase-specific and real-agent tests are not required for this change.
