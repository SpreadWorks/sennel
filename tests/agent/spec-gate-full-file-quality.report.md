# Partial Spec Gate comparison

The user requested skipping the remaining comparison after implementation and functional verification. Eighteen of thirty planned trials completed. The nineteenth trial (`large-real-normal/4/baseline`) was terminated and is excluded from completed results. The five-pair acceptance comparison was not completed or declared passed.

The immutable manifest and JSON report preserve inputs, rules, provider settings, product hashes, raw assessments, usage and parent semantic reviews. The preliminary probe used different inputs/product hashes and is excluded.

## Observed quality

| Case | New version | Baseline |
| --- | --- | --- |
| Large saved normal Spec | 3/3 correct | 2/3 correct; 1 response-size error |
| Large derived violation Spec | 3/3 semantically correct | 0/3 correct; 2 target-contract errors, 1 result with four extra findings |
| Small normal Spec | 3/3 correct | 3/3 correct |

Every completed new-version trial used one CLI launch. One new violation trial used `29-second`, `41-second` and `14-second`; the frozen lexical scorer expected plural `seconds` and marked two misses/extras. Parent review confirmed exactly the same three expected violations and their targets/revision. The original automatic assessment is retained with this explanation, without changing the input, expectations or scorer.

## Partial timing evidence

Only quality-matched pairs are included below. Failures and incorrect results do not count as speed improvements.

| Case/pair | Baseline milliseconds | New milliseconds | Baseline/new CLI launches |
| --- | ---: | ---: | ---: |
| Large normal / 2 | 1,414,332 | 109,453 | 12 / 1 |
| Large normal / 3 | 1,571,377 | 87,449 | 12 / 1 |
| Small normal / 1 | 7,960 | 8,979 | 1 / 1 |
| Small normal / 2 | 8,101 | 7,856 | 1 / 1 |
| Small normal / 3 | 9,463 | 11,282 | 1 / 1 |

There is no quality-matched large violation pair. The planned five-pair medians remain unverified. These individual measurements support only the observed cases.

## Conditions and limits

- Actual configured provider: `codex/gpt-5.6-luna`, with the configured 60,000-character request limit and alternating version order.
- Sennel response caching was bypassed; provider-side prefix caching remained possible and cached-token usage is recorded in JSON.
- Timing covers `checkGuardrail` entry through return, including temporary-file creation, provider reading, protocol retries and cleanup. It excludes canonical retrieval and Flow transitions.
- Large normal input is a saved 126,446-byte Spec. Large violation input derives from it with controlled distant requirement/task conflicts and a justified exception. Small input is synthetic.
- Four frozen control rules provide a focused semantic comparison, not a full production-guardrail quality guarantee. CLI launches are not model-call counts.
- Production code hashes were unchanged during measurement. The comparison process and its AI children were stopped; temporary comparison data and progress logs were removed after preserving this report.
