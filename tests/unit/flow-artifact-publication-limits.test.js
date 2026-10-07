import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowArtifactCatalog, FlowArtifactDescriptor, FlowArtifactCatalogSnapshotLimits } from "../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";

function descriptor(logicalKey, size, parameters = {}) {
  const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  return new FlowArtifactDescriptor({ logicalKey, relativePath: artifact.relativePath,
    authoritySlot: artifact.authoritySlot(), hash: "a".repeat(64), size,
    mediaType: "application/json", retention: artifact.contract.retention.toString() });
}

test("prospective catalog limits include generated state, ledger and unique source content", () => {
  const catalog = new FlowArtifactCatalog({ artifacts: [
    descriptor("flow.state", 100), descriptor("flow.activities", 700),
    descriptor("spec.gate.repair.source.blob", 100, { digest: "b".repeat(64) }),
  ] });
  const limits = { maxArtifactBytes: 100, maxConfirmedLedgerBytes: 700, maxTotalArtifactBytes: 900 };
  assert.doesNotThrow(() => new FlowArtifactCatalogSnapshotLimits(limits).assertProspectiveCatalog(catalog));
  for (const [field, value, message] of [
    ["maxArtifactBytes", 99, /artifact bytes/],
    ["maxConfirmedLedgerBytes", 699, /artifact bytes/],
    ["maxTotalArtifactBytes", 899, /aggregate artifact bytes/],
    ["maxArtifacts", 2, /artifact count/],
    ["maxManagedEntries", 1, /managed entries/],
    ["maxCatalogBytes", Buffer.byteLength(`${JSON.stringify(catalog.toJSON(), null, 2)}\n`, "utf8") - 1, /catalog publication bytes/],
  ]) assert.throws(() => new FlowArtifactCatalogSnapshotLimits({ ...limits, [field]: value }).assertProspectiveCatalog(catalog), message);
});
