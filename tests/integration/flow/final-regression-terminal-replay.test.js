import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  resolveCanonicalFinalRegressionTransition,
} from "../../../src/flow/lib/final-regression-transition-facts.js";
import { createTmpDir, removeTmpDir, writeFile } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  activateNonBlockingPolicy,
  decisionContextForActiveFlow,
  recordNonBlockingDecision,
} from "../../../src/flow/lib/nonblocking.js";

const SPEC_ID = "001-test";
const SCRIPT_PATH = "final-regression-fixture.sh";

function setupCanonical(root, script) {
  writeFile(root, SCRIPT_PATH, script);
  initGitRepo(root);
  commitAll(root, "initial");
  const flowManager = makeFlowManager(root);
  const fixture = new FlowAtStepFixture({
    flowManager,
    specId: SPEC_ID,
    runId: "run-terminal-replay",
    request: "Verify terminal final-regression replay.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: { goal: "Verify terminal final-regression replay.", requirements: [] },
    targetStep: "final-regression",
  }).create();
  commitAll(root, "record canonical final-regression frontier");
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    config: { test: { command: `sh ${SCRIPT_PATH}`, timeout: 5 } },
    flowManager,
    flowState: fixture.state(),
  };
}

function resolveTransition(ctx, flowManager = ctx.flowManager) {
  const state = flowManager.canonicalState(SPEC_ID);
  const store = new CanonicalTestArtifactStore({ flowManager, state });
  return resolveCanonicalFinalRegressionTransition({
    flowManager,
    specId: SPEC_ID,
    changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
      root: ctx.executionRoot,
      relativeSpecFile: store.location.relativeSpecFile,
    }),
  });
}

async function executeAndApply(ctx) {
  const result = await new RunFinalRegressionCommand().execute(ctx);
  await FLOW_COMMANDS.run["final-regression"].post(ctx, result);
  ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
  return result;
}

describe("final-regression terminal replay guard", () => {
  let root;
  let invocationFile;

  afterEach(() => {
    if (root) removeTmpDir(root);
    if (invocationFile) fs.rmSync(invocationFile, { force: true });
  });

  it("does not execute the project command for a terminal failed Attempt replay", async () => {
    root = createTmpDir("final-regression-terminal-replay-");
    invocationFile = path.join(os.tmpdir(), `sennel-final-regression-${process.pid}-${Date.now()}.log`);
    const ctx = setupCanonical(root, [
      `printf '%s\\n' invoked >> ${JSON.stringify(invocationFile)}`,
      "exit 1",
      "",
    ].join("\n"));

    const first = await executeAndApply(ctx);
    const decision = resolveTransition(ctx);
    const second = await new RunFinalRegressionCommand().execute(ctx);

    assert.equal(first.result, "fail");
    assert.equal(Object.hasOwn(first.artifacts, "retryable"), false);
    assert.equal(second.result, "fail");
    assert.equal(Object.hasOwn(second.artifacts, "retryable"), false);
    assert.equal(second.artifacts.replayed, true);
    assert.equal(decision.disposition.operation, "blocked");

    const snapshot = ctx.flowManager.readCanonicalTransitionSnapshot(SPEC_ID);
    const mismatchedManager = new Proxy(ctx.flowManager, {
      get(target, property) {
        if (property === "readCanonicalTransitionSnapshot") {
          return () => ({
            ...snapshot,
            catalog: snapshot.catalog.map((descriptor) => descriptor.logicalKey === "final.regression"
              ? { ...descriptor, hash: descriptor.hash === "0".repeat(64) ? "f".repeat(64) : "0".repeat(64) }
              : descriptor),
          });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.throws(() => resolveTransition(ctx, mismatchedManager), /snapshot catalog hash is stale/);
    assert.equal(fs.readFileSync(invocationFile, "utf8"), "invoked\n");
    assert.equal(fs.existsSync(path.join(
      root,
      "specs/001-test/001/steps/final-regression/attempt-002.log",
    )), false);
  });

  it("does not infer a retry of a non-retryable Attempt from input drift", async () => {
    root = createTmpDir("final-regression-terminal-changed-");
    invocationFile = path.join(os.tmpdir(), `sennel-final-regression-changed-${process.pid}-${Date.now()}.log`);
    const script = [
      `printf '%s\\n' invoked >> ${JSON.stringify(invocationFile)}`,
      "exit 1",
      "",
    ].join("\n");
    const ctx = setupCanonical(root, script);

    const first = await executeAndApply(ctx);
    writeFile(root, SCRIPT_PATH, `# changed input\n${script}`);
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const decision = resolveTransition(ctx);
    const second = await new RunFinalRegressionCommand().execute(ctx);

    assert.equal(first.result, "fail");
    assert.equal(second.result, "fail");
    assert.equal(second.artifacts.replayed, true);
    assert.equal(decision.disposition.operation, "blocked");
    assert.equal(decision.disposition.reason, "stale_changed_file_snapshot");
    assert.equal(fs.readFileSync(invocationFile, "utf8"), "invoked\n");
    assert.equal(fs.existsSync(path.join(
      root,
      "specs/001-test/001/steps/final-regression/attempt-002.log",
    )), false);
  });

  it("keeps final-regression advisory identity stable across activation and reload", async () => {
    root = createTmpDir("final-regression-nonblocking-reload-");
    const ctx = setupCanonical(root, "exit 1\n");
    await executeAndApply(ctx);
    activateNonBlockingPolicy({
      root,
      flowManager: ctx.flowManager,
      reason: "The canonical final regression is acceptance-backed.",
    });
    const reloaded = makeFlowManager(root);
    const context = decisionContextForActiveFlow(root, reloaded.load(SPEC_ID), reloaded);
    recordNonBlockingDecision({
      root,
      flowManager: reloaded,
      choice: "continue",
      reason: "Continue with the recorded final regression failure.",
      remainingRisk: "The report retains the failed regression evidence.",
      expectEvidenceDigest: context.evidenceDigest,
      expectIdentity: context.identity().toJSON(),
    });
    assert.equal(reloaded.canonicalState(SPEC_ID).nextAction().nodeId, "report");
  });
});
