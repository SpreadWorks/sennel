# Cross-platform source audit

Run `npm run check:os-independence` from the repository root. The command inspects
the whole declared source scope without executing inspected modules. It prints
JSON containing source SHA256 fingerprints, scope, coverage, located diagnostics
and the exit status. Exit `0` means every target passed the bounded static checks;
it does not prove equivalent runtime behavior. Violations and incomplete
inspection always return nonzero. An incomplete audit returns `2`.

The developer audit is deliberately separate from the standard test gate. Existing
product violations remain failures in the audit. Selftests use synthetic source
graphs and isolated filesystem roots, so removing a product violation does not
break a fixed violation baseline. `npm run test:structure` always includes checker
selftests and the existing Flow architecture rules.

## Cross-platform policy

`AGENTS.md`'s cross-platform contract is authoritative: Linux, macOS and Windows
must offer the same public functionality, results, effects and failure handling.
OS selection, native commands and platform-specific flags are permitted inside
an inspected shared implementation boundary. Their presence is not a violation.

The checker interprets supported identity comparisons separately for `linux`,
`darwin` and `win32`, using source data rather than the analyzer's OS. Named
function and class-method bodies support `if`/`else`, early returns, `switch`
(including fallthrough and an unsupported-OS default), and conditional returns.
Aliases use the existing binding and dependency resolver. The selected routes
must all reach a normal result/effect shape. Missing routes, rejection and no-op
routes fail; unmatched effect/result or filesystem-flag guarantees remain
incomplete. A checked caller's platform context follows the existing helper-call
path into the typed launch boundary.

Private helper capabilities also use the union of OS contexts reaching their
resolved callers. The existing callable resolver supplies call edges and the
lexical origin index accounts for aliases and unresolved uses. Exported functions
and module initialization still require all supported platforms. Escaped or
unresolved callers remain incomplete; a known incompatible call still fails even
alongside an unresolved one. No helper body or source file is excluded.

Boundary registration and call indexing finish before guarantee classification.
Helper signatures use the selected OS route through the same source evaluator,
and dependent guarantees resolve lazily with an active-resolution guard. Cycles
and unsupported paths that cannot prove guarantees are incomplete within the
finite analysis budget, independently of declaration order. Conditions are indexed
before route execution, so an unconditional rejection cannot hide a later missing
implementation behind unreachable dispatch code.

Known executable identities carry their available platforms. A conditional
`node.exe`/`node` launch is allowed when all routes use the same typed boundary;
an unconditional Windows-only launch lacks the other implementations. Unknown
`custom.exe` or `helper.cmd` identities are incomplete, not violations inferred
from a suffix. Public instruction slots have no inferred OS dispatch contract,
so unconditional instructions still require an executable on every supported OS.
Native `.cmd`/`.bat` execution must also meet the actual child-process contract.

This is a structural check, not inference of a feature's complete semantics.
Unknown predicates, unsupported control flow, unmodeled selectors, opaque helper
control, and mismatched guarantees cannot establish support. Matching API/result
shapes do not prove equal returned data, process lifetimes, durability or failure
behavior. `coverage.contract` states this limit in the machine-readable report.
Platform branch tests and real Linux, macOS and Windows executions are still
needed to establish runtime equivalence; executing this suite on Linux is not
execution on the other two systems.

The old tests were corrected because the old policy prohibited OS identity and
executable spelling themselves. Unknown dispatch predicates now expect incomplete
inspection; unknown command suffixes no longer expect a blanket violation. New
positive routes and missing/reject/no-op/weakened-guarantee negatives assert the
replacement contract. Source roots, violations and incomplete checks remain in
scope without exclusions, baselines or skips.

Process signalling also follows its arguments: a proven positive PID with a
documented portable signal (including signal `0` for an existence check) does not
become a violation merely for calling `process.kill`. Process-group PIDs require
compatible OS routes; an unknown PID/signal contract remains incomplete. See
the official [process signal contract](https://nodejs.org/api/process.html#signal-events).

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
or host OS as the inspected program's environment. An unconditional OS-specific
path, or one used on an incompatible selected platform, is a violation. An
appropriate path inside a complete shared boundary is allowed. Uncertain
composition that retains a sensitive origin is incomplete.
Template interpolation uses the shared reader's expression boundaries and keeps
origins through templates and concatenation. Diagnostic OS text remains allowed;
URL pathname I/O remains rejected. Unsupported sensitive
string transforms retain their origin rather than becoming successful inspection.
Native string path formatting consumes POSIX storage separators while preserving
underlying OS-sensitive origins. Windows logical separators remain distinct
because native POSIX formatting does not convert backslashes into separators.
Known output that both native path flavors accept, such as a relative POSIX
join, is allowed directly. Other logical paths require a compatible selected OS;
unknown roots stay incomplete. The old blanket logical-formatter test was
corrected for this reason. See the official
[path separator contract](https://nodejs.org/api/path.html#pathsep).

Tagged templates use the same lexer chunks and interpolation boundaries.
Unshadowed `String.raw` consumes raw chunks without consulting the host OS;
unknown tags retain cooked/raw strings and interpolation origins. An unsupported
tag becomes incomplete at I/O even with ordinary input, since that input cannot
prove the tag's output. Further transforms retain the same origin.
Ordinary paths, diagnostic output and non-executed strings remain allowed.

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

Both native source launches and public instructions use the same
`NodeExecutionBoundary`. Node eval/print options are inspected before the script operand or explicit
`--` boundary. Later application argv, including unresolved string data, remains
data. An unresolved argument before that boundary is incomplete. Known value-taking options
consume their operand. Known switches such as `--no-warnings` keep the same
sequential option inspection active; an unknown prefix remains incomplete rather
than guessing a script boundary from later arguments. Command-string words come
from the same shell syntax walk; native argv does not acquire shell parsing. This
is an execution-boundary check, not complete Node CLI validation. Typed argv validation alone does not
inspect a `-e`/`--eval`/`-p` body. Inline programs without an inspected module
boundary are incomplete, including harmless programs; their contents are never
classified by forbidden-word matching.

`--import` operands with a `data:` URL are also inline modules, in both joined
and separate option forms. The URL scheme is inspected without decoding or
executing its payload; base64 and ordinary contents receive the same incomplete
diagnostic. File preloads remain module operands, and option-looking application
data after a script or `--` does not acquire execution authority.

At owned typed callers, an unresolved executable identity also stays incomplete;
a string-type guard cannot establish that Node's execution options are inert.

The supported typed launch shape proves an immutable class with a validated
nonempty executable string and copied string argv, a guard against that resolved
class, and consumption of that same instance with `shell: false`. An unrelated
guard, changed argv, unknown shape or escaped capability is incomplete. Test-owned
child launches additionally require retained handles and proven cleanup; inline
Node programs are incomplete when their body and ownership cannot be inspected.

Evidence hashes use the same cached bytes that the checker read. This identifies
the observed source and does not claim an atomic snapshot of a concurrently edited
filesystem. An unreadable or unsupported entry remains an incomplete diagnostic.

Filesystem flag availability follows the supported Node runtime contract, with
Windows file mapping treated as an implementation optimization rather than a
replacement for a public no-follow/durability guarantee. See the official
[filesystem constants](https://nodejs.org/docs/latest-v18.x/api/fs.html#file-open-constants)
and [child-process contracts](https://nodejs.org/docs/latest-v18.x/api/child_process.html).
