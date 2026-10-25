# Registered command execution

Commands use `NativeExecutableInvocation` or `NodeScriptInvocation`. Their
arguments, environment, working directory, and stdio are immutable values.
Display text is never parsed back into an executable command.

An invocation's `env: null` retains inheritance provenance; each execution captures
the caller's current ordinary environment before a synchronous thread hop, while
an explicit environment replaces ambient values. Executable resolution and the
resolved launch stored in private inventory use the same selected environment.
The registered child still receives freshly authenticated delegation downstream.

Configure a Node test runner as:

```json
{
  "test": {
    "command": {
      "kind": "node-script",
      "script": "tests/run.js",
      "args": []
    }
  }
}
```

A native program uses `{ "kind": "native", "executable": "tool", "args": [] }`.
Hooks use the same invocation codec. Legacy shell strings are rejected with a
conversion example. Convert known commands explicitly; shell syntax is not
guessed. Node scripts use the current `process.execPath`.

Windows installed Node shims resolve through the shared executable resolver.
Other batch programs use its explicit cmd adapter. Batch parameters containing
line breaks are rejected because that interpreter cannot preserve their native
argv meaning. Native executables and Node scripts retain literal arguments.
Linux, macOS, and Windows execution evidence must be reported separately.

## Git policy inputs

`runGit`, `runGitAsync`, and `runGitToFile` use the common runner through
`GitCommandExecution`. Pass the selected repository as `cwd`; a literal `-C`
argument does not replace the runner's checkout authority. `GitRepositoryPolicy`
removes inherited repository-location and config-injection overrides. Its
`readOnly` option disables optional Git locks, while configuration isolation is
an explicit policy input rather than a global change to ordinary Git behavior.
Case-insensitive duplicate environment keys are rejected before execution.

Untracked diff collection scopes its complete Git batch through the shared
managed-process API. It borrows existing authenticated execution authority;
standalone reads use an owned read-only invocation workspace, so their control
records do not enter the repository listing or change Git status. File diffs
are submitted sequentially with their original limits and ordered output. This
paces this producer without changing runtime admission or communication budgets.
The CLI and standalone helper share the workspace lifecycle. Successful closure
and completion permit scratch cleanup; a failed callback or closure retains
diagnostics, and simultaneous callback/closure failures preserve both causes.

`GitOwnedStagePolicy` takes explicit Git directory, worktree, index, object-store,
template, and attributes-file paths already owned by the calling storage
operation. It requires absolute paths and isolates global/system configuration.
Restoration additionally requires the owned attributes file and selects literal
LF behavior through explicit Git arguments. Archive operations can supply their
attributes input without enabling restoration behavior. The policy does not
acquire ownership of arbitrary paths. Downstream restoration and archive callers
reuse these inputs and the existing storage authorities instead of reinjecting
reserved environment variables after sanitization.

## Admission and termination

`ProcessExecutionRuntime` provides one call registry and admission authority.
Its independent Node coordinator records reservation, launch claim, observed
spawn or spawn failure, exit, stop requests, output cutoff, receipts, and audit
publication. `DirectChildExecutor` keeps the actual `ChildProcess` handle in the
calling sandbox. The synchronous runner uses one fixed worker; it does not
spawn another bridge process for every command.

The registry's `requests` list records ordinary registry-mutating requests
and completed observation responses; it is not a complete operation audit.
Authentication, event/runtime queries, read-control, output-spool transfers, and
event acknowledgements/dispositions use the existing per-request UUID ledger.
Observation acceptance also uses that ledger, but its completed response is
published inline with the observed child facts in one full registry save. Its
pending ledger record remains evidence; only an exact completed inline record
can take precedence during replay. Other pending requests still refuse replay.
Event publication stages its metadata in a detached registry, saves changed
facts before completing the request record, and keeps each writer callback
followed by its own acknowledged publication. Acceptance is durable before
dispatch. Exact replays retain their operation, payload and authorization identity.
Output transfer writes only its owned spool and capture progress. Output and
observation effects share fresh registry, checkout, inventory, target and authority
checks before and after dispatch. Observation effects use a detached working graph;
their final save retains complete normalization, encoding and physical readback
before acknowledgement. Calls, events, exit observations and final child receipts
remain in the strictly validated registry. Inspection does not scan or merge the
separate request ledger into that inventory. The same three response slots of
2, 4 and 8 seconds share the unchanged 14-second operation budget; an unknown
result grants no new execution, owner release or automatic recovery.

The executor/session and one launch claim bind a child to its reservation.
Inherited authentication can arrive before the executor's actual `started`
observation is committed. That exact authenticated request waits before durable
acceptance, then checks current admission again after the start commit. Duplicate
requests share the original communication deadline. Exit, stop, or admission
fencing wakes the request for a strict check. This wait leaves the registry
queue and mailbox scanner available to receive the executor's observation.
Queue admission uses the same absolute deadline and communication failure;
expiration never supplies running authority.

The mailbox scanner yields an event-loop turn after submitting each new request,
so socket callbacks and timers can run between filesystem jobs. Pending
authentication leaves later mailbox arrivals available for processing. Registry
mutations continue through the existing admission queue.

After a transaction releases its physical admission lock, the committed result
reaches the response publisher before the next local FIFO body can block IO.
The existing queue order and absolute admission deadlines remain the same.

An acknowledged request, process identifier, missing heartbeat, or successful
`kill()` call does not prove exit. The coordinator permits leaf termination
before parent termination. Missing exit observations remain `stop-unconfirmed`
after a finite deadline. Communication reuses the managed request protocol and
its three response slots of 2, 4, and 8 seconds.

An exclusively published mailbox response may briefly have two links while its
owner removes the publication stage. The response remains unreadable until it
has one link; the client waits within the same response slot and request ID.
A persistent foreign hardlink never yields an acknowledgement. Exhaustion keeps
the unsafe response cause and the original 14-second budget. Bootstrap response
reads follow the same rule; storage-authority markers and request reads remain
strict.

TCP attempts keep their existing priority. A mailbox exchange is constructed
only when an operation actually falls back to it, so healthy TCP does not need
access to unused mailbox directories. Later TCP attempts for that operation
check confirmed physical settlement first, then the retained exchange's
completed response to the same already published request. This read never
publishes a fallback request.
The saved request bytes and response identity must match exactly, and the same
single-link checks apply. A response saved during an earlier fallback can
therefore complete a later attempt within its original deadline.

The coordinator selects a leaf's permitted signal from its original stop
operation: `SIGTERM` during the configured grace, then `SIGKILL` afterward.
Waiting for descendants never restarts that grace or deadline. The executor
requests each selected signal once and records its actual last request. The
first timeout notification owns its diagnostic and event; later notifications
cannot replace its reason or threshold. Signal requests still require an actual
exit observation before a receipt can prove completion.
Reservation records capture the selected grace before spawn, so an autonomous
timeout uses the same requested value as an explicit stop. The private runtime
and archive schema 8 require this field; older records are refused unchanged.
Timeout diagnostics use the first committed stop operation's grace. If a local
timeout races with an ordinary exit and no stop operation commits, the diagnostic
uses the configured grace or the shared 100 ms default.

Text output callbacks run after the actual start observation is committed.
While that publication is pending, the existing bounded capture retains the
output prefix; its text chunks may be coalesced when publication completes.
Physical byte observers and activity monitoring still receive output immediately.
After a confirmed abort receipt, an ordinary caller-supplied `Error` remains the
same error object and keeps its existing code. An error without a code receives
`ABORT_ERR`; the default `AbortSignal` reason keeps the process API's wrapper.

Receipt schema 3 covers **registered executions**. It binds the immutable origin,
checkout identity, actual executor, exit or spawn-failure observation, output
cutoff, descendant closure digests, and stop operation clock session. Unregistered
plugin children and unrelated process trees are outside this receipt's claim.
An observed exit with an inherited pipe still open can have incomplete output;
termination and output completeness are independent facts.

A provider's final answer and successful exit leave every registered tool call's
receipt obligation intact. Unfinished calls follow the existing parent-exit and
descendant-drain stop paths. Missing receipts at the cutoff produce a typed
`stop-unconfirmed` failure and retain the unresolved owner and call records.
Instructions to wait for tools do not supply completion evidence.

Sealing a checkout closes its business calls while its typed ownership reservation
keeps the coordinator alive. Closing that already sealed scope preserves the held
reservation. After release, close waits for actual coordinator exit. Failed
handoff cleanup releases only the current sealed runtime's matching reservation
before that wait; a successfully acquired main runtime still closes before its
earlier source reservations are released.

After the original checkout is removed, that same live sealed coordinator can
release its reservation using an operation-local retained checkout view. The
existing admission FIFO and physical lock still guard the operation. Fresh
anchor, inventory, complete closure, epoch and original owner session checks
must succeed before publication or release. A recreated checkout must match
the original physical identity; a replacement cannot inherit its reservation.
The view grants no new execution or ownership and does not survive the operation.

A normal release archives eligible closed executions before releasing the
original owner's lock. Bound events still awaiting canonical publication keep
their existing live outbox; archiving never discards that pending authority.
Recovery-only release leaves historical inventory unchanged. A rejected oversized
reservation creates no call or call artifacts. Its exact durable request stores
the typed capacity refusal, so the same request replays that refusal without
changing the registry. A new valid request can still use the same owner.

A still-live owning coordinator can explicitly revoke a reservation only before
any launch claim or permit. `ProcessExecutionReservationRevocation` binds that
authenticated non-launch decision to the exact checkout, invocation and binding;
it has no executor, exit observation or stop receipt. A crashed owner or missing
receipt cannot manufacture this fact. Prompt recovery can reuse the existing
provider reservation only from this exact revocation or complete inventory
absence, preserving its original budget and invocation lineage. Registry and
archive schema 8 store schema 2 revocations separately from child receipts.

The private registry retains the exact invocation and resolved launch, including
argv and environment. Published receipts, revocations, recovery summaries and
Activity contain only typed semantic identifiers, the disclosure-safe command
descriptor and an `invocationDigest` of the complete private input. Root readback
recomputes that projection and digest; changing the private input cannot preserve
a valid closure. Stored public proofs reject extra private fields. Delivery
cleanup compares hashed executable and exact bootstrap import identities rather
than exposing the launch environment. Prompt journals and canonical artifacts
use the same public proof, preserving the original provider budget and lineage.
Reading a physical result requires its typed call and an identical receipt and
outcome in the committed runtime inventory. A physical result written before a
failed registry commit cannot authorize downstream completion.

Archive files are captured at every existing validation boundary, including
registry commit readback. Within one inventory read or one exclusive coordinator
request, matching file identity, digest and exact bytes can reuse an already
validated archive's decoding. A Store can also weakly retain that deeply frozen
closed archive value between requests. Each use still captures the actual file
and compares checkout, filename, identity, digest and exact bytes. Changed bytes
or a collected observation receive the full strict decoder. Directory, anchor,
inventory, event and finalization checks still run at each boundary. The current
read or request holds its observations strongly until those checks finish; the
Store does not keep expanded historical graphs alive or cache authority.

A Store can retain one deeply frozen registry graph between requests. Every
read captures the actual registry file and checks the anchor, checkout, archives
and call inventory. Only identical file identity, digest and exact bytes can
reuse decoded data. Mutable readers receive independent registry, execution,
call, request and fence records and arrays; only deeply frozen nested values
are shared. Each publication still normalizes and validates the complete graph
before writing. Its exact physical readback must succeed before retaining the
new observation, and save returns an independent working graph after transition
completion. A physical mismatch or failed public Store read or save discards retained
data. Owner, authorization, executor and current-clock decisions still run for
each operation. Timeout changes use the existing detached working graph before
publication. Output transfer keeps both fresh barriers and its comparison
encoding before durable request acceptance. Request-ledger publication,
communication slots and stop budgets are unchanged.

The owner coordinator may release its own exclusion after its host disappears
only when every reservation already has its exact child receipt or revocation. An unknown
coordinator or unfinished child is never reclaimed by PID, elapsed time, boot
identity, or process birth fingerprints.

## Public inherited execution

```text
sennel command -- executable argument ...
```

The wrapper requires its inherited Sennel execution grant. It authenticates the
parent call, checkout, capability, and runtime revision before spawning. A run ID
alone grants nothing. Arguments after `--`, stdin, stdout/stderr, and ordinary
exit codes are forwarded. Agent prompts direct external executions through this
wrapper. This is independent of any agent host's hooks.
The common instruction also requires commands to finish before the agent's
final response. The effective system prompt, including this instruction, is
part of the response-cache identity. The instruction does not replace physical
completion evidence or guarantee an agent's compliance.
Authentication returns a bounded client view and its own delegated grant. It
does not disclose the root capability, sibling capabilities, or private inputs
from the owning registry.

A utility can close its input pipe and still exit normally. The wrapper preserves
that exit and retains any input write error in the durable outcome. Agent prompt
delivery keeps its own stricter success check for complete input delivery.

The inherited grant carries the physical parent's exact binding in both its
scope and digest. Borrowed clients hydrate that authenticated parent binding,
including an explicitly null binding. Root clients retain their selected scope,
so unbound cleanup cannot silently acquire the enclosing Flow binding.

The builtin bootstrap obtains and validates the parent's fixed runtime before
importing a mutable on-disk loader. The ordinary delivery path uses closed
snapshot files, content digests, and a read acknowledgement. Delivery cleanup
requires the corresponding acknowledgement or confirmed owned-child shutdown.
The authenticated `runtime-snapshot` response encodes those same captured bytes
once as a gzip/base64 envelope. Bootstrap checks its exact schema, revision,
canonical base64, decoded length and digest, with a 32 MiB decompression ceiling,
then performs the same complete resource-inventory and per-file proof. The
encoded response keeps its existing frame bound. Raw delivery and the local
closed-file acknowledgement path retain their existing representation.

The minimum Node version is 18.19. Runtimes offering `module.registerHooks` use
its synchronous hooks; earlier supported runtimes use `module.register` and its
isolated loader thread. Both paths use the same snapshot and resolution policy.
Modern package capture runs in an isolated worker before semantic modules enter
the application's module cache. Capture requires both acknowledgement and an
observed successful worker exit within its finite startup window. A termination
request alone grants neither snapshot proof nor cleanup authority. This API
selection preserves exact stderr without suppressing Node warnings.

The wrapper must reach its owning coordinator through authenticated loopback TCP
or the owned filesystem mailbox. Read-only filesystem execution can use TCP
without writing runtime records in the caller. An environment denying both IPC
and mailbox writes cannot register a new child or report its exit through these
transports. The wrapper refuses before target spawn in that environment; this
refusal is not evidence that the required normal execution path works there.

## Storage, recovery, and audit

All repository exclusion uses `RepositoryLockAuthority` and its typed locations
in `.tmp/runtime/repository-control`, including runtime admission, managed
records, Flow stores and leases, and Agent cache locks. Lock schema 2 binds a
random owner token and process-local session. A complete valid record is busy
exclusion, not evidence that its process is alive. `ProcessLock` refuses
contention immediately; `FileLock` uses its finite default wait or an explicit
caller-selected wait policy. Incomplete, corrupt, legacy, or unverifiable owner
records are immediate typed refusals. Inspect creates and deletes nothing.

Owner creation reuses `AtomicFile`'s closed stage and exclusive publication,
followed by owned-stage removal and exact single-link readback. A two-link
observation supplies no readable owner or release authority. `FileLock` treats
only that publication-pending outcome as a wait within its existing policy;
persistent or foreign links remain preserved at timeout. Other invalid file
shapes and malformed single-link records retain their immediate refusal.

Release requires the exact holding instance, token/session, and physical file
identity. The local ownership registry permits detection of same-process
reentrancy; it cannot authorize release by another process. Crashed publication
or release leaves unknown evidence, and complete crashed-owner records remain
busy. Known old paths, including hardlink-publication staging residue, are
checked before new namespace admission. They are not reclaimed or converted.

Layout journal revision 8 records an explicit journal
writer release. Prepare journal revision 3 records the exact repository
operation owner and physical execution checkout. New exclusion plus complete
runtime evidence is checked before effect validation and recovery. Old PID-owner
journals remain unchanged and are explicitly rejected.

Trusted command metadata selects read-only, inspect, and dry-run storage before
container initialization. A minted `ReadOnlyInvocationWorkspace` holds runtime,
delivery, and logging data while preserving the real checkout identity. It is
not a canonical state store or a resume authorization. Cleanup requires normal
coordinator exit and verified release; unconfirmed execution retains evidence.
The dispatcher's block logger receives that same workspace through its existing
temporary-path input and uses the workspace's retained read and append authority.
Ordinary block logs keep their selected project or main-repository location.

Read-only dispatch retains argument, target, and command validation while
omitting lifecycle application hooks, Attempt failure recording, and durable
Step log metadata. A Review preview reaches its existing explicit refusal before
acquiring an execution lease. Artifact views retain canonical source validation;
their optional cache and summary scratch use the minted workspace, scoped to
the selected Spec and Version. Direct cache operations retain their explicit
Version-local storage behavior.

`flow run sync --dry-run` renders the existing `WritePlan` through `ExecutionMode`
before process admission. Its artifact contains the build, review, add, and
conditional commit plan. It starts no documentation process, Git operation, or
canonical writer. Normal synchronization commits the same plan's real pipeline.

Process code imports no Flow writer. Seven durable outbox events pass through an
injected writer port to canonical Activity:

- `outbox_process_reserved`
- `outbox_process_started`
- `outbox_process_spawn_failed`
- `outbox_process_exited`
- `outbox_process_stop_requested`
- `outbox_process_stop_unconfirmed`
- `outbox_process_result_finalized`

Events retain their original Attempt, source and parent identities, sequence,
and digest. Duplicate acknowledgements are idempotent; conflicting payloads are
refused. Pending publication is not a saved-log success. These observations do
not select a retry or semantic Flow route.

A successful call reservation associates the scope's supplied writer with that
call's exact admitted binding, including a provider's refined contract binding.
The association precedes the readback fault boundary. Its events therefore use
the original writer before later general command events; no historical or
foreign binding receives a fallback writer. Canonical origin and sequence
validation remains unchanged.

Source and Git validation inside an existing catalog lock retains its original
compare-and-swap boundary. Process facts become durable immediately, while
canonical publication is deferred until that lock is released. Normal and thrown
paths flush the pending facts after unlock. The writer's own catalog accesses do
not recursively flush or acknowledge the same event. Pure catalog reads that
defer no drain add no event query. Deferral grants no acknowledgement or
runtime-only disposition; finalization still requires actual canonical saves.

Source request preparation also keeps its own process observations pending until
its existing checkpoint save and readback finish. Its full canonical generation,
approval checks and source compare-and-swap remain exact. Subsequent observations
are checked by the existing source handoff prefix validation. A failed audit
publication cannot fabricate another checkpoint or a provider launch.

The writer returns a typed canonical acknowledgement containing the exact event
ID and digest. An explicit runtime-only disposition is a separate typed fact;
it never counts as canonical publication. Both facts are checked against their
immutable event on save and readback. Closed roots with pending bound events
remain in the live registry so a successor can publish them with their original
Attempt identity. They are archived only after publication or an explicit
runtime-only disposition.

Explicit finalization and automatic completion both ask the owning runtime for
a `ProcessExecutionFinalizationBarrier`. Its selection is the exact
`runId`/`specId`/`flowVersionId`, so admission is closed for every Attempt of that
Flow before the selected call closures and event cutoff are saved. An unfinished
registered call returns `finalization-pending` with the fence retained. The
runtime then drains the selected outbox and saves the barrier only after every
selected event has a canonical acknowledgement; missing acknowledgements return
`activity-pending`. The barrier binds `callClosures` with an explicit `child-exit` or
`reservation-revoked` kind and exact closure digest, event identities and sequences,
the cutoff, and acknowledgement digest. The matching `result-finalized` event
uses the same closure kind and digest; revocation is not an exit observation.

The canonical reducer checks that barrier against its exact Flow identity and
saved process events. Save-before-ack retries return the same Activity and the
same barrier, without appending events after finalization. A current runtime
obtains a barrier even when its selected inventory is empty. Pure Store callers
with no process facts may finalize without claiming physical execution coverage.
The root runtime may still perform explicitly unbound cleanup; it cannot reopen
the finalized Flow selection. Every successor checks historical admission
fences. Barrier confirmation and saved-inventory readback also require every
older selected root to be closed and its selected events canonically
acknowledged. Receipt coverage remains registered executions,
and source effects and checkout handoff retain their separate authority checks.

Query revision 4 adds process observations without changing historical Activity
bytes. Parent references resolve within the same query snapshot, including
parents on other pages; missing references are explicit errors.
The projection signature hashes the captured runtime package's source manifest,
not the mutable installation tree. Editing installed source therefore cannot
change an active runtime's snapshot or invalidate its cursor; a fresh bootstrap
captures the new projection. Runtime observation inputs and canonical bytes are
still validated for that snapshot, while transport request/ack bookkeeping does
not by itself change the public execution graph.

## Verification

Use the registered execution, coordinator, wrapper, runtime delivery, lock,
read-only CLI, process-event Activity/query, and owner-contract integration
suites for their corresponding boundaries. Run the production Draft and Spec
artifact scenarios and `npm run test:agent` after changes to their shared
execution path. Synthetic provider output and platform branch tests do not
replace real-agent or real-OS execution evidence.

The revision 7 owner fixture in `tests/fixtures/process-owner-v7` preserves exact
bytes from the previous source commit and records the producer and checksum.
It verifies rejection rather than reconstructing missing ownership or stop
proof. Test roots with unconfirmed execution must remain available until their
execution lifetime is resolved.
