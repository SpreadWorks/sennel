# Structure suite

The structure suite checks source architecture contracts, including placement,
dependency direction, dependency injection, and Service public boundaries. The
Draft and Spec scopes use the same inspection and rule implementation.

Keep a phase scope to its entry directory and production registration selection.
Do not put checker callbacks, allowlists, or individual class names in a scope.
Use production registration and declared dependencies as the source of truth so
tests do not duplicate production wiring.

Trace indirect imports and re-exports through the dependency graph. A target
parse failure, unresolved dependency, or unreadable reverse-reference index
means the check is incomplete and must fail. Do not make valid violations pass
through per-file exclusions, violation baselines, or skips.

The Spec scope loads `specStepRegistrations` from the production composition;
missing, empty, and invalid exports fail before inspection. Isolated registration
fixtures prove that a valid export reaches the shared checker. They do not replace
the production registration check.

Scope analysis supports `let` and `const` bindings. It rejects `var` declarations
as unsupported rather than treating them as block-scoped. The lexical-only A06
reference index can still read files containing `var` outside the inspected closure.

Meaningful checker values use dedicated classes with constructor invariants.
Keep source inspection static; do not evaluate source code to extract
dependencies. Structure tests cover side-effect-free inspection and construction.
Checks requiring live state belong in integration or phase scenario tests. A07
coverage compares production-registered Service dependencies with actual instances
inspected there; the structure suite itself does not construct live Services.
The Spec integration scope prepares every registered Spec Step through canonical
Flow state and its production Service preparation API, then inspects each
`PreparedStep.dependencies`. It must fail when any production-declared Service
type lacks a prepared instance.

The shared checker lives under `tests/support/structure/`; phase suite
entrypoints live under `tests/structure/`. Keep dependency extraction and graph
traversal separate from the shared Flow rules:

| Rule | Contract |
| --- | --- |
| A01 | Step inheritance, placement, and production registration agree in both directions. Reject empty scopes, missing or duplicate registrations, and moved Steps. |
| A02 | Steps reference only common base contracts, values/helpers, and their declared injectable Service modules. |
| A03 | Trace helper dependencies recursively; reject Store, Definition, execution infrastructure, composition, Step, and unclassified boundaries. |
| A04 | Reject Service access through helpers or re-exports. Classify the entire module even when an import selects only a value. |
| A05 | Reject dynamic loading and direct prohibited globals in the Step/value closure. Normalize builtin names and permit only path, util, and crypto. |
| A06 | Index all source JavaScript for static imports, re-exports, and literal dynamic imports of scoped Steps. Only composition may reference them. Production construction must use declared dependency types. |
| A07 | Assert that actual Service instances have no public own data properties, including non-enumerable and Symbol properties. Keep state in private fields. |

Common base contracts are `src/flow/engine/step.js`, `step-result.js`, and
`flow-execution-error.js`; inspect their dependencies too. Composition belongs
under `src/flow/engine/composition/`, Services under `src/flow/services/`, and
Steps under `src/flow/steps/<phase>/`. A Step moved into a helper or Service
directory is still a misplaced Step. Stop dependency traversal only at a
properly declared Step-to-Service boundary; Service internals are outside this
inspection scope.

Diagnostics include a rule ID, source location, and dependency path. Report the
inspected closure and Service boundaries even on success. A06 distinguishes
computed imports (outside its reference contract) from lexical failures (an
incomplete index that must fail).

Use synthetic source graphs, including a renamed second phase, to test rules
without tying expectations to known production files. Integration tests apply
the same checker to isolated copies with injected violations and exercise real
production registration and Service construction. Run `npm run test:structure`;
the suite also runs through default `npm test` and `npm run test:all`.
