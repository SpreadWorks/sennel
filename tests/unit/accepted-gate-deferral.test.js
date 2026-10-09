import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptedGateDeferral, AcceptedGateFindingsPublication } from "../../src/flow/lib/accepted-gate-deferral.js";
import { GateAttemptIdentity, GateCatalogPublication, GateTargetBinding, GateFailureCategory } from "../../src/flow/lib/gate-transition.js";

test("accepted Gate deferral preserves only its exact original failed source receipt and evidence", () => {
  const publication = new GateCatalogPublication({ attemptId: "gate-evaluation-5", sequence: 5,
    producerActivityId: "failed-gate-publication", artifactId: "steps/impl/gate/result.json", fingerprint: "a".repeat(64) });
  const continuation = new AcceptedGateDeferral({ sourceReceiptId: "b".repeat(64), sourceResultDigest: "c".repeat(64),
    sourcePublication: publication, settlementAttempt: new GateAttemptIdentity({ id: "gate-decision-6", sequence: 6 }),
    findingsPublication: new AcceptedGateFindingsPublication({ logicalKey: "flow.findings",
      relativePath: "flow.findings.json", hash: "d".repeat(64), size: 10, findingCount: 1 }) });
  const evidence = {
    identity: new GateTargetBinding({ runId: "source-run", specId: "source-spec", stepId: "impl-gate",
      attempt: publication.attempt }),
    publication, result: "fail", failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
    toJSON() { return { identity: this.identity.toJSON(), publication: this.publication.toJSON(),
      result: this.result, failure: this.failure.toJSON(), observation: "unresolved behavior",
      continuation: continuation.toJSON() }; },
  };
  const originalEvidence = evidence.toJSON();
  delete originalEvidence.continuation;
  const input = { receipt: { id: continuation.sourceReceiptId, resultDigest: continuation.sourceResultDigest },
    resultDigest: continuation.sourceResultDigest, evidence, originalEvidence };
  continuation.assertOriginalSource(input);
  for (const [name, change] of [
    ["another source receipt", (value) => { value.receipt.id = "e".repeat(64); }],
    ["another stored Result digest", (value) => { value.receipt.resultDigest = "e".repeat(64); }],
    ["another observed Result digest", (value) => { value.resultDigest = "e".repeat(64); }],
    ["another source Flow", (value) => { value.originalEvidence.identity.runId = "foreign-run"; }],
    ["another catalog fingerprint", (value) => { value.originalEvidence.publication.fingerprint = "e".repeat(64); }],
    ["a fabricated successful evaluation", (value) => { value.originalEvidence.result = "pass"; }],
    ["changed original observations", (value) => { value.originalEvidence.observation = "changed behavior"; }],
    ["a previously accepted source", (value) => { value.originalEvidence.continuation = continuation.toJSON(); }],
    ["a previously advisory-accepted source", (value) => { value.originalEvidence.acceptedDecision = {}; }],
  ]) {
    const changed = { ...input, receipt: { ...input.receipt }, originalEvidence: structuredClone(originalEvidence) };
    change(changed);
    assert.throws(() => continuation.assertOriginalSource(changed), TypeError, name);
    continuation.assertOriginalSource(input);
  }
  assert.equal(input.originalEvidence.result, "fail");
  assert.equal(input.originalEvidence.continuation, undefined);
});
