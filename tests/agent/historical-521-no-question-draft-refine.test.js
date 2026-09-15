import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import GetNextActionCommand from "../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import { Agent } from "../../src/lib/agent.js";
import { Container } from "../../src/lib/container.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { findStepById } from "../../src/flow/lib/step-tree.js";
import {
  CanonicalFlowFixture,
} from "../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

const SENNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/sennel.js");
const MODE = process.env.SENNEL_HISTORICAL_521_MODE;
const EVIDENCE_FILE = process.env.SENNEL_HISTORICAL_521_EVIDENCE;
const SNAPSHOT = process.env.SENNEL_HISTORICAL_521_SNAPSHOT;
const REPOSITORY = process.env.SENNEL_HISTORICAL_521_REPOSITORY;
const HISTORICAL_PROFILE_KEY = "codex/gpt-5.6-luna";
const HISTORICAL_PROVIDER = Object.freeze({
  command: "codex",
  args: ["exec", "--json", "--sandbox", "workspace-write", "-m", "gpt-5.6-luna", "{{PROMPT}}"],
  jsonOutputFlag: "--json",
  jsonSchemaFlag: "--output-schema",
  jsonSchemaMode: "file",
});

function historicalAgentConfig() {
  return { agent: {
    default: HISTORICAL_PROFILE_KEY,
    timeout: 600,
    retryCount: 0,
    providers: { [HISTORICAL_PROFILE_KEY]: HISTORICAL_PROVIDER },
  } };
}

function installSennelWrapper(root) {
  const bin = path.join(root, ".test-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "sennel"), [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SENNEL)} \"$@\"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return bin;
}

function historicalAgent({ root, flowManager }) {
  return new Agent({
    // #521 records model gpt-5.6-luna and no effort; do not substitute the
    // current built-in `-low` profile for this historical comparison.
    config: historicalAgentConfig(),
    paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(historicalAgentConfig().agent.providers),
    logger: new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: false }),
    flowManager,
  });
}

function writeEvidence(document) {
  if (!EVIDENCE_FILE) return;
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(document, null, 2)}\n`);
}

function dispatchContainer({ root, flowManager, agent }) {
  const value = new Container();
  value.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
  value.register("mainRoot", root);
  value.register("config", historicalAgentConfig());
  value.register("inWorktree", false);
  value.register("flowManager", flowManager);
  value.register("agent", agent);
  return value;
}

function completedAction() {
  return {
    taskId: null, step: null, action: "completed", instructions: null, context: null,
    output_schema: null, requires_approval: false,
    directive: { kind: "completed", terminal: true, requiresUserAction: false },
  };
}

describe("historical #521 no-question draft refinement", { timeout: 720_000 }, () => {
  it("measures the first worker boundary from the recorded #521 start conditions", {
    skip: MODE ? false : "set SENNEL_HISTORICAL_521_MODE=before or after to run the isolated comparison",
  }, async () => {
    assert.ok(["before", "after"].includes(MODE), "historical mode must be before or after");
    assert.ok(SNAPSHOT && REPOSITORY, "supply an immutable retained draft/issue snapshot and baseline repository copy");
    const snapshotBytes = fs.readFileSync(SNAPSHOT);
    const snapshot = JSON.parse(snapshotBytes);
    assert.equal(snapshot.draft.questionLedger.questions.length, 0);
    const root = createTmpDir("historical-521-no-question-");
    const originalPath = process.env.PATH;
    const trace = { mode: MODE, startCommit: "7e3123fc417dec2f1856642fe5c060d2501c2165", profileKey: HISTORICAL_PROFILE_KEY };
    trace.snapshotDigest = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
    trace.snapshotOrigin = snapshot.origin;
    trace.replayKind = "controlled replay using retained current draft; original pre-refine draft unavailable";
    try {
      fs.cpSync(REPOSITORY, root, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
      initGitRepo(root);
      commitAll(root, "historical #521 fixture baseline");
      process.env.PATH = `${installSennelWrapper(root)}${path.delimiter}${originalPath}`;

      const specId = "521-no-question-draft-refine";
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "historical-521-no-question",
        issue: 521,
        request: snapshot.issue,
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().registerActive().activate("draft");
      flowManager.confirmCurrentAttempt({
        specId,
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(snapshot.draft, null, 2)}\n`),
        }],
      });
      // This uses the same typed lifecycle operations that reach the worker
      // frontier in production.  The only seed is the no-question draft.
      fixture.activate("draft-refine");

      const context = {
        root, mainRoot: root, executionRoot: root, specId, flowManager,
        flowState: flowManager.loadReadOnly(specId),
        expectRunId: "historical-521-no-question", expectSpec: specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      };
      const selected = await new GetNextActionCommand().execute(context);
      trace.selected = { step: selected.step, action: selected.action, directive: selected.directive?.kind };
      const agent = historicalAgent({ root, flowManager });
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run(container, input) {
            const action = await new GetNextActionCommand().run(container, input);
            // Let Definition settle conditional workers, but stop before the
            // coverage Review would begin a separate provider invocation.
            return action.step === "draft-coverage-review" ? completedAction() : action;
          },
        },
        agent,
        repositoryFingerprint: () => "historical-521-no-question",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = dispatchContainer({ root, flowManager, agent });
      const result = await dispatcher.execute(context);
      const state = flowManager.loadReadOnly(specId);
      trace.result = result;
      trace.dispatch = result.dispatch ?? null;
      trace.currentStep = state.currentNodeId;
      trace.agentMetrics = state.metrics.filter((metric) => metric.phase === "draft-refine").map((metric) => ({
        provider: metric.provider, profileKey: metric.profileKey, callCount: metric.callCount,
        durationMs: metric.durationMs, tokens: metric.tokens,
      }));
      trace.activityOperations = flowManager.activityLedger(specId).map((entry) => entry.transition.operation);
      const refine = findStepById(state.steps, "draft-refine");
      const next = await new GetNextActionCommand().execute({ ...context, flowState: state });
      trace.persisted = { refineStatus: refine.status, currentStep: state.currentNodeId, nextStep: next.step };
      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(trace, null, 2));
      assert.equal(refine.status, "done", JSON.stringify(trace, null, 2));
      assert.equal(state.currentNodeId, null, JSON.stringify(trace, null, 2));
      assert.equal(next.step, "draft-coverage-review", JSON.stringify(trace, null, 2));

      if (MODE === "before") {
        assert.equal(selected.step, "draft-refine");
        assert.equal(trace.agentMetrics.length, 1, JSON.stringify(trace, null, 2));
        assert.equal(trace.agentMetrics[0].callCount, 1);
        assert.equal(trace.agentMetrics[0].provider, "codex", JSON.stringify(trace, null, 2));
        assert.equal(trace.agentMetrics[0].profileKey, trace.profileKey, JSON.stringify(trace, null, 2));
        assert.equal(flowManager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "draft"), true);
        assert.equal(flowManager.activityLedger(specId).some((entry) => (
          entry.transition.operation === "confirm_attempt"
          && entry.nodeId === "draft-refine"
          && entry.result?.artifactRefs?.some((reference) => reference.kind === "worker-handoff")
        )), true);
      } else {
        // The Step identity remains draft-refine for lineage, while Definition
        // selects the parent-owned skip command instead of a worker action.
        assert.equal(selected.step, "draft-refine");
        assert.equal(selected.directive?.kind, "execute_command");
        assert.equal(selected.directive?.actionId, "COMPLETE_CONDITIONAL_WORKER");
        assert.equal(trace.agentMetrics.length, 0, JSON.stringify(trace, null, 2));
        assert.equal(fs.existsSync(path.join(root, ".sennel", "handoffs")), false);
      }
    } finally {
      writeEvidence(trace);
      process.env.PATH = originalPath;
      removeTmpDir(root);
    }
  });
});
