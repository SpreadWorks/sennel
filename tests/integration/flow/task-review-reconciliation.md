# Task Review orphan reconciliation: backward causal coverage

This explicit recovery adopts the inspected **current unreviewed input**. It
does not reconstruct a missing past parent baseline, certify zero source effects,
or publish a Review result. Ordinary baseline/receipt recovery remains unchanged.

| Guaranteed outcome | Necessary conditions and producer | Durable/readback boundary | Test |
| --- | --- | --- | --- |
| Same Review can be evaluated after restart | Failed, unpublished recovered Review, missing baseline/receipt, no earlier reconciliation; explicit target, reason and preview digest | Definition admission; one `retry_recovery_attempt` transaction publishes new baseline and immutable reconciliation; fresh manager and next-action | orphan preview/readback |
| Old failure and worker evidence survive | Archive manifest and exact input bytes before adopting current source | Activity prefix unchanged; archived bytes hash-checked against catalog publication; old files retained | orphan preview; readback admits |
| Changed or wrong input is refused | Match canonical state/catalog, source, HEAD/index, manifests and input hashes to preview | Recheck under catalog lock before publication; match adopted input again before next-action and worker | stale source/index/head/canonical; confirmation and guards; post-recovery changes |
| No concurrency with the old Review | Acquire the existing Attempt's Review execution lease | Lease acquisition before canonical transaction | live Review lease |
| No acceptance bypass or unlimited retry | No published Review result; no semantic/source-integrity failure; only one reconciliation for the Task | New Attempt preserves semantic consumption and exhausts tooling allowance; no Gate claim/result | orphan preview; normal exhausted Review |

Historical-gap setup uses the Runtime's old artifactless confirmation/recovery
calls, as in `missing-producer-artifact-recovery.test.js`, after a real source
handoff. It never edits live Flow data. AI/provider and child-process boundaries
are faked. The final worker-admission scenario deliberately returns a tooling
failure; it proves admission and preservation, not successful AI execution.

Existing `task-review-causal-scenarios.test.js`, `task-review-checkpoint-recovery.test.js`,
and `recovery-admission.test.js` retain ownership of normal recovery, protocol
classification, semantic accounting, checkpoint authorization, and generic
artifact-publication refusal. Reconciliation adds no legacy baseline fallback.

Unmeasured boundaries: OS termination during the catalog journal transaction,
arbitrary external editor writes during worker execution, and real provider
behavior. These tests do not establish completeness against unknown failures.
