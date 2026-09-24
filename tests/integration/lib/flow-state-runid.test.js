import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let root = null;
afterEach(() => {
  if (root !== null) removeTmpDir(root);
  root = null;
});

describe("canonical Flow run identity", () => {
  it("ignores a legacy root flow.json without rewriting its bytes", () => {
    root = createTmpDir();
    const file = path.join(root, "specs/001-test/flow.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"specId":"001-test"}\n');
    const before = fs.readFileSync(file);

    assert.equal(makeFlowManager(root).loadReadOnly("001-test"), null);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it("requires runId before the Version root is created", () => {
    root = createTmpDir();
    assert.throws(
      () => new CanonicalFlowFixture({
        flowManager: makeFlowManager(root), specId: "001-test", runId: null,
      }).create(),
      /runId/,
    );
    assert.equal(fs.existsSync(path.join(root, "specs/001-test/001")), false);
  });

  it("preserves runId in the exact schema-3 identity", () => {
    root = createTmpDir();
    const fixture = new CanonicalFlowFixture({
      flowManager: makeFlowManager(root), specId: "001-test", runId: "existing-run-id-123",
    }).create();
    const loaded = fixture.state();
    const wire = JSON.parse(fs.readFileSync(fixture.location().flowStateFile, "utf8"));

    assert.equal(loaded.runId, "existing-run-id-123");
    assert.equal(wire.runId, "existing-run-id-123");
    assert.equal(wire.schemaRevision, CURRENT_FLOW_SCHEMA_REVISION);
    assert.equal(wire.lifecycle.state, "active");
  });
});

describe("preparing Flow run identity", () => {
  it("creates the transient preparing document through PreparingFlowStore", () => {
    root = createTmpDir();
    const manager = makeFlowManager(root);
    const runId = "test-run-id-abc";
    manager.createPreparingFlow(runId, { request: "prepare the change" });

    const state = manager.loadPreparingFlow(runId);
    assert.equal(state.runId, runId);
    assert.equal(state.lifecycle, "preparing");
    assert.equal(state.specId, null);
    assert.equal(state.autoApprove, false);
  });

  it("allows independent preparing runs and deletes only the selected run", () => {
    root = createTmpDir();
    const manager = makeFlowManager(root);
    manager.createPreparingFlow("run-1", { request: "first" });
    manager.createPreparingFlow("run-2", { request: "second" });

    assert.deepEqual(new Set(manager.listPreparingFlows()), new Set(["run-1", "run-2"]));
    manager.deletePreparingFlow("run-1");
    assert.equal(manager.loadPreparingFlow("run-1"), null);
    assert.equal(manager.loadPreparingFlow("run-2").request, "second");
  });
});
