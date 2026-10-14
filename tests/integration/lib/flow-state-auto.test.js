import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
function createTmpProject() {
  const tmp = createTestDirectory("flow-auto-");
  fs.mkdirSync(path.join(tmp, ".sennel"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "specs", "001-test"), { recursive: true });
  execFileSync("git", ["init", tmp], { stdio: "ignore" });
  return tmp;
}

function createFlowState(tmp) {
  return new CanonicalFlowFixture({
    flowManager: makeFlowManager(tmp), specId: "001-test", runId: "run-test",
    execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/001-test" },
  }).create().registerActive();
}

describe("flow-state autoApprove", () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpProject();
    createFlowState(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sets autoApprove to true through the typed policy Activity", () => {
    makeFlowManager(tmp).setAutoApprove(true);
    const loaded = makeFlowManager(tmp).load();
    assert.equal(loaded.autoApprove, true);
  });

  it("sets autoApprove to false through the typed policy Activity", () => {
    makeFlowManager(tmp).setAutoApprove(true);
    makeFlowManager(tmp).setAutoApprove(false);
    const loaded = makeFlowManager(tmp).load();
    assert.equal(loaded.autoApprove, false);
  });

  it("autoApprove defaults to false when not set", () => {
    const loaded = makeFlowManager(tmp).load();
    assert.equal(loaded.autoApprove, false);
  });

  it("preserves autoApprove across independent typed observations", () => {
    makeFlowManager(tmp).setAutoApprove(true);
    makeFlowManager(tmp).addNote("policy remains active");
    const loaded = makeFlowManager(tmp).load();
    assert.equal(loaded.autoApprove, true);
    assert.equal(loaded.request, "Fixture request");
    assert.equal(loaded.notes.at(-1).text, "policy remains active");
  });
});
