# Draft Gate full-file real-provider comparison

## Result

The file route completed all 15 trials and matched the frozen expectations in every trial. The baseline completed all 15; one large violation trial gave the three right findings at the right QA decisions but incorrectly set every `where.file` to `spec.json`. There were no false PASS results, false positive findings, evaluation-unavailable results, or provider errors. On the four large violation pairs where both outputs met the strict finding and location expectation, median semantic Gate time was **146.55 s baseline versus 57.85 s file** (60.5% lower). On five large normal pairs, median time was **129.87 s baseline versus 56.98 s file** (56.1% lower). Small inputs used one CLI launch in both variants on every trial.

This is a controlled hybrid comparison, not proof of a real over-limit input: the largest unchanged canonical Draft in this repository is 50,538 characters, and its complete inline request with current project Draft guardrails is 59,107 characters under the configured 60,000-character limit. The 71,913/71,996-character over-limit cases below extend that real Draft with explicitly synthetic QA and validation text. The user subsequently waived the requirement for an unchanged real Draft Gate input over the configured limit. That comparison was not performed and is no longer an acceptance blocker; the measured evidence remains limited to the cases described here.

A follow-up sizing check used the production Draft checker role instead of the default role: the same source and 12 project Draft rules measured 59,169 characters, or 59,674 with all 12 IDs supplied as previously passed. Both provider projections fit the configured 60,000 limit. The all-IDs case is a conservative sizing probe, not an asserted historical evaluation state. This worktree's preset resolver reported `Preset not found: node-cli`; these figures therefore cover the available project rules, not a successfully resolved preset chain. They do not establish that an unavailable deployment or rule set could never produce a real over-limit request.

## Frozen input and method

- Baseline: Git revision `aea1f13cf1a3556444aa50d7a8b6afc1bc3a168a`, extracted by `git archive` into `.tmp/draft-gate-full-file-quality/baseline` within this worktree, with no Git metadata. Baseline `run-gate.js` SHA-256 `715ae9dd1835c46b326b5a52c6baa0446d9bbba27137d8652fb2ac938657b40e`; `gate-prompt-plan.js` SHA-256 `c829b85d52e16fb6bc97b1fdaaeb9ac106716b981613d62328b550a1ec5b5201`.
- File variant: uncommitted product source held constant for all 15 file trials. `run-gate.js` SHA-256 `a43a7382ba9491d76c8b1a25039ded35c44613e10748652f50289a293a075fbf`; `gate-prompt-plan.js` SHA-256 `88897c390e5f7d8cd5e81c50fbd466155eaba8c7ef59bc01eaea634511f27ab5`. Each trial records both product hashes.
- Actual configured `agent.useProfile=codex-only` resolved `flow.spec.gate` to `codex/gpt-6-sol-medium`, with built-in Codex provider settings, retry count 2, and prompt character limit 60,000. No provider or model override was applied. Both variants received identical case bytes and rule objects. The Sennel cache was bypassed equally; provider-side prefix caching was not disabled. Pairs alternated execution order (`file → baseline`, then `baseline → file`).
- Historical seed: `specs/252-persistent-rules-injection/001/steps/draft/result.json`, 50,538 characters, SHA-256 `2e54559096c0047638189df1cd643e4354216db81df4ce596bf951394218da6d`. The seed is an authentic saved Draft in an older schema. The generated over-limit fixtures retain its content and append synthetic K7 decisions and neutral QA context. The entirely synthetic small case follows the current canonical Draft shape. The [manifest](draft-gate-full-file-quality.manifest.json) fixes exact source hashes, added material, rules, and expected findings before provider execution. The body fixtures are regenerated and checked byte-for-byte by the [harness](draft-gate-full-file-quality.mjs) in `.tmp`, to avoid legacy text affecting the normal test suite.
- Expected violations in the large violation case: `checkpoint-timeout` at `qa[9].answer` (29 versus 14 seconds) and `qa[29].answer` (41 versus 14 seconds); `checkpoint-rejection-reason` at `qa[19].answer` (bulk-bypass rejected without a reason in that answer). The large normal case changes both timeout answers to 14 seconds and supplies the rejection reason. The `draft-stage-validation` rule deliberately does not demand executed test evidence at Draft stage. Expected findings are zero for both normal cases. The harness scores rule, distinctive observed facts, `where.file`, and exact QA index or decision label. I reviewed every observation against the frozen source after execution.
- Timing starts at `checkGuardrail` entry and ends at its return. It includes prompt planning, runtime file preparation and cleanup, provider file reading, schema handling, and retries. It excludes the upstream canonical artifact fetch, mechanical Draft validation, and Flow transition. CLI launch counts come from Gate `recordPromptMetric.callCount`; `thread.started` events agreed in all 30 trials. Provider usage comes from Codex JSON events when available. A separate [pilot](draft-gate-full-file-quality.probe.json) ran before the final file schema was frozen and is excluded from all figures below.

## Paired trials

Times are seconds; the number in parentheses is CLI launches. `C` means the frozen findings and locations match. `L` means correct finding content with an invalid `where.file`. Every trial reached a normal Gate result; no failure-time sample exists.

| Case | Pair | Baseline | File |
| --- | ---: | ---: | ---: |
| Large violation | 1 | 142.7 (7), C | 74.9 (1), C |
| Large violation | 2 | 144.5 (7), C | 55.0 (1), C |
| Large violation | 3 | 148.6 (7), C | 51.9 (1), C |
| Large violation | 4 | 167.6 (7), L | 58.7 (1), C |
| Large violation | 5 | 176.0 (7), C | 60.7 (1), C |
| Large normal | 1 | 126.3 (7), C | 53.2 (1), C |
| Large normal | 2 | 112.0 (7), C | 57.0 (1), C |
| Large normal | 3 | 129.9 (7), C | 39.1 (1), C |
| Large normal | 4 | 134.4 (7), C | 64.8 (1), C |
| Large normal | 5 | 132.2 (7), C | 69.2 (1), C |
| Small normal | 1 | 8.1 (1), C | 9.0 (1), C |
| Small normal | 2 | 19.6 (1), C | 8.7 (1), C |
| Small normal | 3 | 8.2 (1), C | 9.7 (1), C |
| Small normal | 4 | 8.1 (1), C | 9.7 (1), C |
| Small normal | 5 | 14.2 (1), C | 8.2 (1), C |

The large violation primary time comparison uses strict quality matched pairs 1, 2, 3, and 5: baseline median 146.55 s (range 142.70–175.98), file median 57.85 s (range 51.89–74.92). Across all five structurally completed large violation pairs, including the baseline location error, medians were 148.56 s (142.70–175.98) and 58.74 s (51.89–74.92). All five large normal pairs were strict matches: baseline median 129.87 s (111.95–134.43), file median 56.98 s (39.12–69.18). Small normal medians were baseline 8.23 s (8.07–19.62) and file 9.01 s (8.16–9.75); the acceptance criterion for small inputs is no structural increase in CLI launches, which held at one each.

The baseline location error was `large-violation/4/baseline`: its three observations correctly described 29/41 versus 14 seconds and the absent rejection reason, and cited the matching QA labels, but each set `where.file` to `spec.json`. The automatic strict scorer labels that trial `miss`; manual review refines it to `content-correct/location-invalid`. It was neither a false PASS nor an omitted violation. The file variant always cited `draft.json` and the correct QA location.

Median provider-reported input tokens (baseline/file) were 198,137/175,521 for large violation, 194,676/262,662 for large normal, and 22,002/21,994 for small normal. Median cached input tokens were 23,808/135,808, 11,904/197,504, and 11,904/0 respectively; median output tokens were 4,025/1,936, 3,765/1,681, and 41/38. These are provider usage observations, not equal-cost estimates. The file method embeds a unique runtime path in each prompt; when Sennel caching is enabled in ordinary operation, that path could reduce exact-prompt cache hits for identical Draft content. This benchmark bypassed the Sennel cache on both sides, while provider prefix caching still operated. Its different cached-token totals and trial order limit conclusions about absolute production latency or cost.

The complete per-trial output, measured duration, CLI counts, usage, source and product hashes, automatic classification, and manual review are in the [JSON report](draft-gate-full-file-quality.report.json). No product fallback was introduced for any comparison outcome.
