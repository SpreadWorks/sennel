# OS independence audit

Run `npm run check:os-independence` from the repository root. The command inspects
the whole declared source scope without executing inspected modules. It prints
JSON containing source SHA256 fingerprints, scope, coverage, located diagnostics
and the exit status. Exit `0` means every target passed; violations and incomplete
inspection always return nonzero. An incomplete audit returns `2`.

The developer audit is deliberately separate from the standard test gate. Existing
product violations remain failures in the audit. Selftests use synthetic source
graphs and isolated filesystem roots, so removing a product violation does not
break a fixed violation baseline. `npm run test:structure` always includes checker
selftests and the existing Flow architecture rules.

The reusable entrypoint is `auditOsIndependence(repository)` in
`tests/support/structure/os-audit.js`; use `SourceRepository(root)` for disk or
`MemorySourceRepository(entries)` for synthetic sources. `auditOsIndependenceAt(root)`
provides the disk entrypoint used by the thin CLI. The returned `OsAuditReport`
exposes `ok`, `complete`, `exitCode`, diagnostics and `toJSON()`.

For rule fixtures, `new OsIndependenceChecker(repository, scope).check()` accepts an
explicit `scope.files` array. Production coverage comes from
`new OsAuditScope(repository).discover()` rather than a caller-maintained file
allowlist. Every discovered implementation is inspected, including modules not
reachable from package entrypoints. Package bin/scripts/distribution declarations
are checked alongside source, scripts and runner/support infrastructure.

The tests root is inventoried one level deep for runner helpers. Suite internals
are outside that selection; source, scripts, support, runner and declared
distribution directories retain strict recursive inventory. Links and special
entries at a selected boundary remain incomplete. `SourceRepository.inventory()`
keeps recursive traversal by default and accepts `maxDepth` for shallow selection.

The inspection contract covers tracked lexical origins, supported literal module
dependencies, public executable instruction slots, and owned structured
serialization/readback/consumer boundaries. Computed loads, escaped sensitive
capabilities and unresolved origins are incomplete. Arbitrary JavaScript and prose
semantics, external plugin implementation internals and user command internals are
outside this guarantee. Owned calling boundaries remain in scope. Distribution
globs contribute a conservative directory-prefix superset to audit coverage;
that coverage is not a claim about npm pack's exact file list.

Native launches and shell-facing instructions share one executable policy but
retain their different contracts. In particular, npm package command shims are
not proof of a portable native launch with `shell: false`; use a proven Node
executable and a resolved JavaScript entrypoint. See the official
[Node child process contract](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
and [npm bin contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin).
Unknown owned literal executables are incomplete, never implicitly portable.

Literal `require()` expressions retain their complete member chain through the
same module graph as imports. Callable CommonJS defaults and forwarding use the
shared export resolver, including its origin-cycle guard. Object binding
projections are shared by declarations, helper arguments and constructors;
unsupported sensitive binding patterns remain incomplete. Bitwise flag operands
retain their origins, and unsupported sensitive operators cannot establish a
proven callable or filesystem path.

Native path composition retains both POSIX and Windows logical interpretations,
including absolute resets and normalization. It never borrows the analyzer's cwd
or host OS as the inspected program's environment. A proven sensitive path is a
violation; uncertain composition that retains a sensitive origin is incomplete.
Template interpolation uses the shared reader's expression boundaries and keeps
origins through templates and concatenation. Diagnostic OS text remains allowed;
URL pathname I/O remains rejected. This repair leaves existing OS-branch rules
unchanged; the branch-policy revision is separate from these origin contracts. Unsupported sensitive
string transforms retain their origin rather than becoming successful inspection.
Native string path formatting consumes POSIX storage separators while preserving
underlying OS-sensitive origins. Windows logical separators remain distinct
because native POSIX formatting does not convert backslashes into separators.

Filesystem calls select path operands from one shared API contract, including
destination operands and stream creation. Data, callback and descriptor operands
do not become paths. A proven stream descriptor overrides its path; unresolved
options retain a conditionally used path. URL/native conversions retain their
input, base and source route. Literal file URLs use OS-independent URL syntax;
native path-to-URL normalization reuses the native path interpretations above.
Uncertain URL destinations stay incomplete. Pathname string transforms keep their
origin at I/O while diagnostic and write-data uses remain allowed.

Public shell text has a bounded syntax check for command separators and nested
execution. Uninspected compound instructions are incomplete. Quotes, escapes and
comment boundaries distinguish execution syntax from inert text; structured
`shell: false` argv stays data. This check does not execute commands or implement
a complete shell parser.

Node eval/print options are inspected before the script operand or explicit
`--` boundary. Later application argv remains data. Known value-taking options
consume their operand, and an unproven prefix cannot establish that a later eval
option is application data. Command-string words come from the same shell syntax
walk; native argv does not acquire shell parsing. This is an execution-boundary
check, not complete Node CLI validation.

The supported typed launch shape proves an immutable class with a validated
nonempty executable string and copied string argv, a guard against that resolved
class, and consumption of that same instance with `shell: false`. An unrelated
guard, changed argv, unknown shape or escaped capability is incomplete. Test-owned
child launches additionally require retained handles and proven cleanup; inline
Node programs are incomplete when their body and ownership cannot be inspected.

Evidence hashes use the same cached bytes that the checker read. This identifies
the observed source and does not claim an atomic snapshot of a concurrently edited
filesystem. An unreadable or unsupported entry remains an incomplete diagnostic.
