# Test suite rules

`tests/runner/` owns discovery, selection, suite invariants and Node's test
process invocation. `tests/support/` contains fixture builders, stubs and
assertion support; it contains no runner policy.

Every `*.test.js` belongs to exactly one directory suite: `unit`,
`integration`, `e2e`, `acceptance`, or `agent`. Preset-local acceptance tests
live at `src/presets/<preset>/tests/acceptance/*.acceptance.test.js`.

Unit tests do not spawn child processes, initialise Git repositories, or run
Flow scenarios. Integration tests own cross-module, filesystem, Git and Flow
fixtures. E2E tests are a small set of public CLI entrypoint scenarios.
Acceptance tests are deterministic and use stubs. Tests which execute an AI
provider or agent CLI live only in `tests/agent/` and are excluded from `npm
test`.

Fixtures are immutable seeds. Each test creates a unique temporary work root,
sets only test-local environment, and removes it in teardown. Never write to
the repository's `.sennel`, Git state, or a shared lock.

## Test design

- **MUST: Every test must prove an observable contract.** Assert the returned
  value, persisted state, emitted artifact, error type/code, or another outcome
  that would change if the behavior regressed. A test must not pass only because
  execution did not throw, an exception was caught, or a command exited zero
  when a more specific result is part of the contract. Never leave an empty
  `catch` in a test.
- Give each test one behavioral reason to fail and name that behavior. Prefer
  exact values, types, error codes, and state transitions over broad truthiness
  or message-only matching. When failure atomicity matters, also assert that the
  protected state remains unchanged.
- Exercise the narrowest stable public interface that proves the contract. Do
  not assert private implementation steps, incidental log wording, ordering, or
  file layout unless that detail is itself an external or durability contract.
- Build valid scenarios through production APIs. Do not manufacture impossible
  internal state to shorten setup. Hand-written malformed state is allowed only
  when rejection of that system-boundary input is the behavior under test.
- Before adding a test that performs state transitions, identify an existing
  production path or test that performs the same transition. Do not infer or
  invent a transition sequence only for test setup; use the public API sequence
  that can occur in production.
- If test setup raises an invariant error, verify that the scenario is a legal
  production state transition before changing product code, assertions, or
  expected results.
- A regression test must reproduce the externally observable failure and fail
  before the product fix. Do not encode the chosen implementation as the
  expected behavior.

## Backward causal scenario design

- **MUST: Start with the observable outcomes to guarantee, then trace their
  necessary conditions backward.** Include successful completion, safe refusal,
  exhausted retries, recovery, and durable intermediate checkpoints. Changes to
  implementation identify review targets; they are not the coverage model.
- For each outcome, record the condition, its consumer, every legal producer
  path, authoritative storage, readback boundary, and covering test. Trace IDs,
  revisions, attempt ordinals, bindings, and recovery baselines where they affect
  the decision. Use current source, specifications, and incident evidence; do not
  assume that a previous fix or its explanation is correct. Derive expected
  behavior from the required contract, not merely from what current code does.
- Treat the backward trace as a dependency graph, not necessarily a single
  line. Cover jointly required conditions, rejection when each required condition
  is absent, alternative producer paths, and combinations that change downstream
  behavior. Merge histories only when the consumer cannot distinguish them under
  the contract. Do not claim coverage from either one happy path or a mechanical
  Cartesian product of every branch.
- Reuse existing tests for isolated decisions and immutable setup. Add scenario
  tests for missing causal connections: production generation, validation,
  classification, persistence, readback, and the resulting decision or effect.
  Fake external provider responses and other nondeterministic boundaries, not
  the internal producer or saved evidence whose correctness is being tested.
  A preconstructed final artifact cannot prove that production creates it.
- For restart and recovery contracts, discard in-memory managers and reconstruct
  them from persisted state without passing the previous result forward. Check
  relevant interruption boundaries, such as before and after publication or
  settlement, and assert failure atomicity and absence of duplicate effects.
  This proves readback behavior, not OS-crash or cross-process behavior unless
  those boundaries are separately exercised.
- A final-outcome scenario may cover an intermediate transition only if its
  assertions would fail when that transition violates its contract. Keep separate
  tests for independently observable intermediate guarantees, refusal paths, or
  recovery checkpoints that a successful final outcome could hide.
- When changing a mechanism, update the outcome-to-condition mapping and check
  all affected consumers and producer paths, not just the newly added branch.
  Record uncovered conditions explicitly. Correct an invalid fixture or expected
  result only with evidence of the legal production contract; never weaken a
  valid regression assertion, skip it, or alter evidence merely to obtain green
  tests or advance a Flow. Product fixes require authorization for that scope.

## Verify regression detection

- Compare the same test inputs, assertions, and fixtures before and after a
  product fix. When evaluating historical fixes, retain the regression tests
  while removing only the relevant product changes in isolated copies. Never
  peel fixes from the live worktree or mutate a running Flow's canonical state,
  evidence, or Git state. Ensure copied Git metadata cannot point writes back to
  the original repository.
- Account for dependencies between fixes. Cumulative removal can expose a first
  failure that masks later defects; use separate cases or isolated comparisons
  to attribute each detected contract violation. A failed test counts as evidence
  for a fix only when that contract passes with the fix and fails without it.
  Syntax/import failures, timeouts, and impossible fixture states do not count.
- Keep unresolved baseline failures separate from newly exposed regressions.
  Report source revisions and relevant uncommitted changes, the frozen test set,
  per-case outcomes, logs, and the fault-to-test mapping. Distinguish measured
  results, inference, and untested boundaries. Detecting every known historical
  fault does not establish completeness against unknown faults or prove the
  fixes themselves correct in all cases.
- Keep expensive historical comparisons separate from the normal test suite.
  Use deterministic local fixtures for Flow integration tests and follow
  `src/flow/AGENTS.md`; do not advance the actual Flow to test its behavior.

## Coverage without duplication

- Search existing tests before adding a case. One rule belongs to one primary
  layer: unit tests own isolated decisions, integration tests own component and
  persistence composition, E2E tests own representative executable wiring, and
  acceptance tests own user-visible outcomes. A higher layer may repeat a lower
  layer input only to assert behavior unique to the higher boundary.
- Do not copy the same success/failure matrix across layers or representations.
  Keep one normal path, meaningful invariant boundaries, and materially distinct
  failure or recovery paths. Use table-driven cases when inputs vary under the
  same contract; do not add permutations without a distinct failure risk.
- Test count is not a quality goal. Delete superseded tests when an API, format,
  compatibility path, or scenario is removed. During alpha, do not retain tests
  whose only purpose is preserving retired behavior.
- CLI subprocesses are reserved for process behavior such as argument routing,
  exit status, signals, environment, stdout/stderr, and cross-process locking.
  Call the underlying class or function for behavior that does not depend on a
  process boundary. Keep only representative CLI paths in E2E.

## Determinism, setup cost, and cleanup

- Use deterministic fakes for clocks, randomness, network, providers, and agent
  responses. Do not use arbitrary sleeps to coordinate concurrency; synchronize
  on an observable event, lock, file, or injected barrier.
- Reuse an expensive common precondition as an immutable seed and clone it into
  a unique work root per test. Never share mutable Flow, filesystem, Git,
  environment, process-global, or lock state between tests merely to save time.
- Keep expensive end-to-end scenarios only when they protect a distinct public,
  durability, security, concurrency, or recovery boundary. Prefer a lower-layer
  deterministic test for the rest. Do not improve runtime by removing required
  assertions or bypassing production durability and authority checks.
- Register cleanup before performing the mutation that may fail. Restore
  environment and process globals and remove every owned root in `afterEach`,
  `t.after()`, or `finally`. Cleanup is teardown, never a test case. The runner's
  scoped `TMPDIR` cleanup is a final safety net, not a substitute for fixture
  cleanup when a test is run directly.
