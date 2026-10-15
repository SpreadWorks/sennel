# Flow stop guidance

This inventory covers every leaf in `FLOW_COMMANDS`, the independent `flow query` wire adapter, and both bootstrap failure stages. The checked-in route and literal-code inventory is [`routes.json`](./routes.json). Its route set is derived from the current command registry, including aliases; each entry names the leaf module and the output adapter that owns its response. The inventory test compares the recorded artifact with source-derived registry and error-code evidence, then verifies each adapter is connected to production publication.

The baseline for this work is `5d2fd96be`. The shared contract lives in `src/lib/flow-stop-guidance.js`; `Envelope.attachStopGuidance()` in `src/lib/flow-envelope.js` is the envelope entry point. The selected `data.directive` remains the only execution authority. Top-level `guidance` is presentation that must reference that same directive. Guidance cannot create a command, binding, retry, or recovery route.

## Route and error coverage

`FLOW_COMMANDS` is recursively traversed to enumerate each registered leaf. The command function must also resolve through `coreCommandRegistry` to the same handler; its core definition declares the envelope output owner. A command class may retain raw text for a successful read-only operation. Its failed returns, throws and later hook failures still reach the common envelope boundary. `flow query` is intentionally separate: it returns query schema revision 3 through its own serializer. The pre-semantic loader has a fixed runtime-only response; after semantic imports are available, bootstrap failures use the common envelope adapter.

The literal-code section scans all JavaScript under `src/flow/` and the shared owners listed in the inventory. It records stable string literals associated with error codes, error constructors, code maps, or inline coded messages. This is lexical evidence, not a proof of every possible runtime code. Dynamic forwarding and fallback families are listed explicitly with their source and evidence expression; generated codes and literals outside the recognized forms remain outside the scan's completeness claim.

## Nested dispatch result contract

`flow run dispatch` returns a nested response. `data.nextAction.directive` is the dispatcher-selected action authority; `data.dispatch.boundary` identifies the boundary class, and `data.stepAttempt` carries durable outcome evidence. For guided stops, the response adapter promotes the selected nested directive to the sole `data.directive` used by the envelope and guidance, while retaining dispatch metadata and the StepAttempt projection. Ordinary completed, aborted and idle responses retain their existing success shape. Boundary labels and StepAttempt outcomes may explain the stop, but cannot override the selected directive or authorize a new action. The integration test exercises this composition through `Envelope.attachStopGuidance()`.

The skill displays guidance first, then follows the existing route from `data.directive.kind`. An `await_task_review_filter` directive remains an agent-host action and continues in the same turn; it does not pause for user confirmation. User decisions and concrete external actions retain the existing Flow interaction rules.

## Output publication lifecycle

The dispatcher accumulates one candidate response across argument parsing, command loading and execution, `pre`, `post`, `onError`, and `finally` handling. Runtime-log records and metadata are written while the physical process-runtime admission remains open. The runtime log closes and metadata commits inside that admission. After the physical runtime closes, the dispatcher attaches final stop facts and guidance to the candidate, serializes one final JSON response, and publishes it once. If semantic response construction fails, it publishes the common contract-failure envelope. After publication, a broken stdout transport uses only the stderr/exit path; it does not attempt a second JSON response. The independent query serializer and fixed pre-semantic bootstrap response are separate output boundaries and are inventoried separately.

Raw Flow stdout is held until these same finalizers settle. Successful text
retains its exact bytes; a later failure publishes its envelope instead of
preceding that JSON with candidate text. `get runtime-log --format json` and
its refusals return typed Envelopes rather than publishing from the command.
Nested `nextAction` objects retain descriptive metadata after directive
promotion. Their prose is redacted as presentation; selected continuation
`nextAction` strings, commands and bindings retain authority validation.

## Reuse gaps addressed

Before this contract, Flow responses had several stop-related shapes: envelope errors, continuation or prompt fields, nested dispatch boundaries, typed query errors, semantic bootstrap errors, and a minimal runtime-loader failure. Consumers had to infer what to explain and what to do from different fields. The common envelope adapter now centralizes acquired facts, safe explanation, and the presentation of the already selected directive. Query and pre-semantic bootstrap remain separate only where their output contracts or module-loading boundary require it; they do not define competing command authority.

The existing nonblocking failure owner now exports `nonblockingFailureContinuation()` for dispatcher use. Its earlier private continuation helper only served callers already admitted to nonblocking handling. The extended contract supports an optional policy check and captures missing target bindings through the existing `FlowTargetBinding` owner; admitted envelope callers retain their required continuation. The dispatcher forwards this selection after retaining existing directives and merging finalizer failures, rather than duplicating policy or guarded-command construction.

## Acceptance and verification map

| Acceptance surface | Implementation evidence | Verification |
| --- | --- | --- |
| Every registered Flow route and alias has an output owner | `routes.json`, `src/flow/registry.js`, `src/lib/command-registry.js` | `tests/integration/flow/stop-guidance-inventory.test.js` exhausts live registry leaves and checks route modules and adapters |
| Literal codes and dynamic families are inventoried with bounded claims | `routes.json`, `tests/support/infrastructure/flow-stop-guidance-inventory.js` | Inventory test re-scans production sources and rejects stale code entries or moved dynamic-family evidence |
| Envelope stops share one selected directive and common guidance | `src/lib/flow-envelope.js`, `src/lib/flow-stop-guidance.js` | `tests/unit/flow-stop-guidance.test.js`, `tests/unit/flow-envelope.test.js`, plus nested dispatch integration coverage |
| Query and bootstrap paths have explicit wire producers | `src/flow/query.js`, `src/lib/flow-cli-failure.js`, `src/sennel.js` | query and CLI integration tests; inventory checks production-connected serializers and builtin-only early loader |
| Dispatcher publishes after lifecycle and runtime closure | `src/lib/dispatcher.js#dispatch` | dispatcher integration tests and inventory publication-boundary checks |
| Skill consumes guidance without inventing recovery or pausing automatic work | `src/skills/partials/stop-guidance.md`, `src/skills/sennel.flow/SKILL.md` | skill validation is run by the parent after the shared edits are integrated |

## Verification

The outcome and evidence mapping, source snapshots, commands, measured results,
and known baseline fixture corrections are recorded in
[`verification.md`](./verification.md). The inventory-specific command is
`node tests/run.js tests/integration/flow/stop-guidance-inventory.test.js`;
the test runner bootstrap is required for runtime proof.
