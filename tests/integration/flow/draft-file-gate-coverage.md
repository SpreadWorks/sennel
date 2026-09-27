# Draft Gate complete-file regression coverage

The Draft Gate keeps the canonical `targetText` inline while the request fits the configured logical and resolved agent invocation limits. Above either limit it writes the exact UTF-8 bytes to a unique runtime `draft.json`, gives the agent its absolute path, logical name, and SHA-256, and evaluates complete rules without source partition or evidence reduction. A file outcome is either observations or a reasoned inability to evaluate. Any incomplete group fails the Gate without publishing earlier observations as a partial result.

| Required outcome or boundary | Owning test |
| --- | --- |
| Inline at the exact configured limit; file immediately below; identical inline text/file bytes; default oversized limit; projected invocation overflow | `tests/integration/flow/draft-file-gate.test.js`: configured logical limit, exact oversized bytes, projection overflow |
| File digest changes with content; per-call temporary file isolation; file survives format repair and is removed afterward | Same file: digest change, simultaneous evaluations, format repair |
| Missing, ambiguous, malformed, or reasoned unavailable responses fail; unavailable does not cause format repair | Same file: invalid outcomes, format repair then unavailable |
| Whole-rule grouping respects projected size; one oversized rule refuses before provider calls; later group failure cannot publish earlier findings | `tests/unit/gate-shared-evidence.test.js`: whole file judgment grouping; integration file: single oversized rule and partial group |
| File creation/write or provider failure is non-PASS and cleans up only its owned directory | Integration file: blocked creation, injected atomic write failure, provider exception |
| Canonical Draft bytes reach the provider, Gate findings are saved and reloaded, and actual Draft repair and Acceptance consumers use them | `tests/integration/flow-cli/draft-artifact-scenario.test.js` with an oversized canonical Draft |

Measured locally: the focused unit and integration tests passed **21/21**; the expanded Draft phase scenario passed **1/1**. The pre-existing Spec batching and original Draft scenario selection passed **18/18** before the scenario was expanded. `git diff --check` passed. For regression detection, the same configured-limit test and assertions passed on the changed tree and failed on an isolated archive of base revision `aea1f13cf1a3556444aa50d7a8b6afc1bc3a168a`: immediately below the limit, the old implementation did not supply the complete-file reference. The expanded Draft phase scenario also failed on that base revision, while passing after the change. These comparisons establish detection of this known fault, not exhaustive coverage of unknown faults.

The implementation reuses `PromptRequestLimit`, `PromptLogicalFootprint`, the resolved `Agent.projectInvocation` projection, `GuardrailJudgmentPlan` for whole-rule grouping, `PromptBatchPlan`/`executeGatePlan` for budgeted calls, `GateOutputProtocolPolicy` for format repair, and `AtomicFile` for durable bytes. The repository runtime artifact registry already owns `.sennel/agent-work/`, but it has no API for a transient input with a lifespan spanning every Gate group and format retry. `DraftGuardrailFileInput` owns only that missing lifespan and its unique directory; canonical artifact loading and Gate persistence remain with their existing APIs.

An independent base-revision check also reproduced three pre-existing unit failures in `draft-step-result-factory`, `plan-gate-repair-route`, and `spec-gate-step-result` (8 pass, 3 fail in the selected 11 cases). Their old Spec repair route expectations are unrelated to this Draft input change; they were not altered here.

The full `npm test` run completed with unit **920/924**, integration **3737/3751**, E2E **43/43**, and acceptance **6/6** passing. One unit failure was caused by generated comparison fixture bodies retaining historical product names outside the historical-spec area. Those bodies now live only in the comparison runtime directory, without changing their bytes or weakening the name check; the final `rename-scan.test.js` rerun passed **2/2**, including the completed comparison reports.

All remaining **17 failures** reproduced on the same isolated base revision: the three unit cases above and 14 integration cases. The integration comparison selected only the failed leaf names with `node --test --test-name-pattern`; it executed **14 tests, 0 pass, 14 fail, 0 skipped**, with the same errors and expected/actual differences. The nine owning test files were unchanged from the baseline:

- `flow-cli/commands/dispatch.test.js`: final Draft answer continuation and invalidated plan-gate approval (2).
- `flow-cli/worker-handoff-full-flow.test.js`: full Flow worker routing (1).
- `flow/flow-steps.test.js`: fixed Requirement lifecycle inventory (1).
- `flow/missing-producer-artifact-recovery.test.js`: exhausted Spec Review recovery (1).
- `flow/set-retry.test.js`: unchanged exhausted recovery rejection for authentication, usage-limit, and subprocess failures (3).
- `flow/spec-gate-result-settlement.test.js`: pre-enabled advisory settlement route (1).
- `flow/worker-artifact-handoff.test.js`: authority inventory and sealed-payload dispatch (2).
- `lib/flow-artifact-contract.test.js`: complete artifact inventory and dispatcher-owned handoffs (2).
- `lib/provider.test.js`: the old GPT-5.6-only builtin profile expectation (1).

These are existing baseline inconsistencies, not a green full suite. No unrelated product code, fixture, assertion, or skip was changed to hide them.

`npm run test:agent` completed with **8 pass, 2 fail, 1 existing opt-in skip** (11 tests). The real Spec shared-evidence quality test passed. The two failures occurred outside the modified guardrail evaluation path:

- `tests/agent/draft-gate-repair.test.js:173` stopped at `draft-coverage-triage` with `FLOW_ARTIFACT_HANDOFF_INVALID`: the model's `items[0].decision` required a user decision. The test had not reached its Gate invocation at line 178; that invocation also explicitly uses `skipGuardrail: true`.
- `tests/agent/spec-gate-repair-decision.test.js:46` received a model response without the expected `baseRevision`. This test directly exercises the unchanged Spec repair prompt/context/operations and does not invoke either changed module.

The owning test files and these producer/consumer paths were not modified. This is source-path attribution of the observed failures, not a claim that the same stochastic AI responses were reproduced on the baseline. No retries were run just to obtain a green result, and the existing opt-in historical test was not enabled or newly skipped.

The separate [real-provider comparison](../../agent/draft-gate-full-file-quality-report.md) completed 30 trials (15 pairs) across three cases. The changed route matched all 15 expectations; large hybrid-input medians improved and small-input CLI launches stayed at one. No unchanged real Draft Gate input over the configured limit was found. The user subsequently waived that comparison requirement; it was not performed and is no longer an acceptance blocker.

## Follow-up code review

After the waiver, the production changes were reviewed again against board 743b, including canonical input acquisition, exact serialization, logical and projected limits, whole-rule planning, failure classification, temporary-file lifetime, and existing Gate publication and repair consumers. The focused rerun executed only `draft-file-gate.test.js`, `gate-shared-evidence.test.js`, and `draft-artifact-scenario.test.js` (**22/22 pass**), plus `gate-prompt-batching.test.js` for the shared Spec path (**17/17 pass**). No full suite or real-provider comparison was rerun. Product code was unchanged during this review.

The requirement to obtain a naturally oversized historical Draft was disproportionate as a blocking implementation check: explicit synthetic additions can exercise the same size boundary and full-content evaluation, while the real-provider comparison verifies actual file access. Five alternating pairs per representative case provide useful one-time performance evidence but do not prove universal model accuracy; this expensive harness remains outside the normal test runner. No new reader-proof mechanism, Flow state, provider-specific hook, fallback, or automatic comparative execution was added.

An independent read-only review found no production correctness defect. It identified a remaining test-coverage limitation: later-group evaluation-unavailable is tested through `checkGuardrail` (failure with empty evaluations), while the canonical Draft scenario covers persistence/readback of completed observations. The specific combination of later-group unavailability followed by canonical failure persistence and reload is not exercised end to end. Source inspection confirms `runGateFlow` routes `failureCode` to `gateRequiredEvaluationFail` before merging findings; this is code evidence, not a claim that the missing combined scenario was executed.
