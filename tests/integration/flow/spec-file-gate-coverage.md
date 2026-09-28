# Parent Spec Gate complete-file and response-limit coverage

The parent Spec Gate shares the Draft complete-file evaluator when the logical or projected request does not fit. It preserves canonical bytes, complete rules, exception rationale, Spec-stage instructions, repair targets and revision bindings. Only the parent Spec execution budget disables the single-response character ceiling. Request, aggregate, item, call and protocol-retry budgets remain independent and unchanged.

| Required result | Verification |
| --- | --- |
| Exact file bytes, digest, complete rules, target schema, projected-size fallback, grouped unavailable outcome, format repair and cleanup | `flow/spec-file-gate.test.js`: 6 passed |
| Shared Draft file behavior, isolation, digest changes and failure cleanup | `flow/draft-file-gate.test.js`: 12 passed |
| Explicit unlimited response contract, default and finite limits, shared budget, aggregate and input rejection | `unit/prompt-batching.test.js`: 29 passed |
| Generic planner honors unlimited response characters while retaining item bounds | `unit/gate-file-judgment.test.js`: 2 passed |
| Large inline/file response survives canonical publication, a new manager, actual bounded repair workers, re-Gate and Approval/Test/Acceptance consumers | `flow-cli/spec-artifact-scenario.test.js`: both large cases passed individually after the new-manager assertions; preceding full Spec/Draft selection passed all 6 cases |
| Earlier group findings are not published when a later group is unavailable; no format repair; temporary file removed; actual failure survives manager reload and produces the existing blocked next-action | `flow-cli/spec-file-failure-scenario.test.js`: 1 passed |
| Existing Gate schema, phase, target, source, history and requirement contracts | Eight selected integration files: 83 passed |
| Other consumer retains finite limits | `flow/auto-check-prompt-budget.test.js`: 4 passed |

The failure scenario uses the registered dispatcher and existing lifecycle failure recording. Tooling failure still publishes no `spec.gate` result and no settlement. Its reason travels in the existing error message into the failed Attempt and activity record. No recovery command or state transition was added.

## Original failure comparison

An isolated archive of baseline `4651be1e23b9ada1c978c6b89cf3137892083b8b` and the changed implementation received the same inline Spec input and schema-valid final response: 139,989 characters containing 40 complete observations. Both used the existing `checkGuardrail` API without new API arguments. The baseline rejected it with `PROMPT_RESPONSE_TOO_LARGE`, retaining zero observations. The changed implementation retained all 40, including their complete observed text and locators. Each used one fake provider call. This detects the original response-ceiling contract violation, independently of the new file response schema.

## Existing failures and review

The full unit run completed with 920/923 passing. The three failing cases in `draft-step-result-factory.test.js`, `plan-gate-repair-route.test.js` and `spec-gate-step-result.test.js` reproduced with the same errors on the isolated baseline (8/11 passing in that selection).

The Spec command-boundary, post-failure and result-settlement selection completed with 19/20 passing. The failed pre-enabled advisory settlement test expects `spec` while the implementation selects `spec-gate-repair`; the same selected test failed identically on the baseline. These existing expectations were not changed.

The parent reviewed the product diff and execution results. A separate implementation agent reviewed the diagnostic propagation and failure scenario and found no new blocking defect. Full-file evaluation and shared limit changes also received an earlier independent implementation review.

## Real-agent acceptance

`npm run test:agent` completed with 7 passing, 2 failing, 1 cancelled by timeout and 1 existing opt-in skip. One failure was the changed Spec quality test: its provider reported that it could not read a file under the runner's `/dev/shm` temporary root. The semantic fixture now lives under the worktree's `.tmp`, matching the complete-file comparison, and asserts the exact saved bytes immediately before the provider call. The targeted real-provider rerun passed (1/1), retaining the two expected rule violations and all target/revision assertions. This changes fixture placement, not the expected semantic result or production filesystem behavior.

The other failed test, `spec-gate-repair-decision.test.js`, received a response without `baseRevision`; it directly invokes the unchanged repair prompt, context and operations. `draft-gate-repair.test.js` hit its existing 720-second timeout. That scenario stops before parent Spec Gate and invokes its Draft Gate with `skipGuardrail: true`. The tests and these producer paths are unchanged from the baseline. This is source-path attribution, not a claim that identical stochastic failures were reproduced on the baseline. Neither expectation nor timeout was weakened, and neither unrelated test was rerun simply to obtain a passing result.

The user requested stopping the remaining old/new comparison after implementation and functional verification were complete. Eighteen of the planned thirty trials completed; the remaining comparison is omitted by that instruction, not reported as passed. The comparison manifest and report under `tests/agent/spec-gate-full-file-quality.*` preserve the fixed input, baseline, provider and trial results. The preliminary probe used an earlier manifest and is excluded from the formal comparison. Before formal trials, the controlled timeout baseline was moved exclusively into a designated task so correct violation findings require reading across requirement and task sections; the expected three findings were fixed before those trials.

All eighteen completed trials received parent semantic review. The changed implementation's nine trials were correct, with one CLI launch each: three large normal, three large violation and three small normal. One large violation result was marked `miss` by the frozen lexical scorer because it used `29-second`/`41-second`/`14-second` instead of `29 seconds`/`41 seconds`/`14 seconds`; direct review confirmed the same three expected findings with matching targets, allowed operations and revision. The automatic assessment is retained alongside the manual explanation.

The baseline completed nine trials: five correct, one result with four extra Spec-stage findings, and three errors (one `PROMPT_RESPONSE_TOO_LARGE`, two `GATE_REQUIRED_SCHEMA` failures because allowed targets were outside targets). Failed pairs are excluded from timing comparisons. Two large normal pairs were quality-matched: old/new durations were 1,414,332/109,453 ms and 1,571,377/87,449 ms, with 12/1 CLI launches in each pair. All three completed small normal pairs were correct with one launch per version. These partial results support the observed cases only; the planned five-pair median comparison and the full fifteen-trial new-version quality acceptance were not completed. In particular, no quality-matched large violation timing pair was obtained. Production code hashes remained unchanged throughout measurement, and the final diff whitespace check passed.
