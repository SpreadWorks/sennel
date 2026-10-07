import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowArtifactCatalogSnapshotLimits } from "../../../src/lib/flow-version.js";
import { SpecGateRepairSourceCaptureBudget, readSpecGateRepairSources } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

test("canonical Issue and Draft capture account exact physical bytes through the production Store reader", async (t) => {
  const value = await createSpecGateRepairScenario({ issue: 42, issueSnapshot: "\ufeffPreserve the 漢🧭 evidence.\r\n" });
  t.after(() => removeTmpDir(value.root));
  const manager = value.flowManager;
  const state = manager.canonicalState(value.specId);
  const inputs = ["issue.snapshot", "draft"].map((logicalKey) => manager.readArtifact({
    specId: value.specId, logicalKey, consumerNodeId: "spec-gate-repair",
  }));
  const budget = new SpecGateRepairSourceCaptureBudget();
  const sources = readSpecGateRepairSources({ flowManager: manager, state,
    executionRoot: value.root, spec: {}, captureBudget: budget });
  assert.equal(budget.readBytes, inputs.reduce((total, input) => total + input.bytes.length, 0));
  assert.equal(budget.serializedBytes, 0);
  for (const input of inputs) {
    const source = sources.find((entry) => entry.origin === input.relativePath);
    assert.equal(source.availability, "available");
    assert.deepEqual(Buffer.from(source.content, "utf8"), input.bytes);
    assert.equal(source.revision, input.descriptor.hash);
  }
});

test("a refused canonical read retains its consumed bytes through one coherent view without changing the Flow", async (t) => {
  const value = await createSpecGateRepairScenario({ issue: 42, issueSnapshot: "\ufeffComplete 漢 evidence.\n" });
  t.after(() => removeTmpDir(value.root));
  const manager = value.flowManager;
  const input = { specId: value.specId, logicalKey: "issue.snapshot", consumerNodeId: "spec-gate-repair" };
  const artifact = manager.readArtifact(input);
  const limit = artifact.bytes.length * 2;
  const budget = new SpecGateRepairSourceCaptureBudget({
    limits: new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: limit, maxTotalArtifactBytes: limit }),
    maxReadBytes: limit,
  });
  const before = manager.readCanonicalTransitionSnapshot(value.specId);
  const fstat = fs.fstatSync;
  let consumed = false;
  let refused = false;
  fs.fstatSync = function (...args) {
    const stat = fstat.call(this, ...args);
    if (consumed && !refused) {
      refused = true;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1 });
    }
    return stat;
  };
  try {
    manager.readCanonicalTransitionView({ specId: value.specId, read: (view) => {
      assert.throws(() => manager.readArtifact({ ...input, view, onRead: (byteLength) => {
        budget.recordRead(byteLength);
        consumed = true;
      } }), /changed while reading/);
    } });
  } finally { fs.fstatSync = fstat; }
  assert.equal(consumed, true);
  assert.equal(refused, true);
  assert.equal(budget.readBytes, artifact.bytes.length);
  assert.equal(budget.remainingReadBytes, artifact.bytes.length);
  assert.equal(budget.serializedBytes, 0);
  assert.deepEqual(manager.readArtifact(input).bytes, artifact.bytes);
  assert.deepEqual(manager.readCanonicalTransitionSnapshot(value.specId), before);
});
