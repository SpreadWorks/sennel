import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { Agent } from "../../src/lib/agent.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { findStepById } from "../../src/flow/lib/step-tree.js";
import RunClaimNextActionCommand from "../../src/flow/lib/run-claim-next-action.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import RunGateCommand from "../../src/flow/lib/run-gate.js";
import RunReviewCommand from "../../src/flow/lib/run-review.js";
import { FLOW_COMMANDS } from "../../src/flow/registry.js";
import { Container } from "../../src/lib/container.js";
import { DraftGateRepairScenario } from "../support/infrastructure/draft-gate-repair-scenario.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

const SENNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/sennel.js");
const RETAINED_SNAPSHOT = process.env.SENNEL_RETAINED_521_GATE_SNAPSHOT;
const RETAINED_REPOSITORY = process.env.SENNEL_RETAINED_521_REPOSITORY;
const PROFILE_KEY = "codex/gpt-5.6-luna";
const PROVIDER = Object.freeze({
  command: "codex",
  args: ["exec", "--json", "--sandbox", "workspace-write", "-m", "gpt-5.6-luna", "{{PROMPT}}"],
  jsonOutputFlag: "--json", jsonSchemaFlag: "--output-schema", jsonSchemaMode: "file",
});

function config() {
  return {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    agent: {
      default: PROFILE_KEY, useProfile: "historical-521",
      timeout: 600, retryCount: 1, providers: { [PROFILE_KEY]: PROVIDER },
      profiles: {
        "historical-521": {
          "flow.dispatch": PROFILE_KEY,
          "flow.draft.review.coverage.propose": PROFILE_KEY,
        },
      },
    },
  };
}

function installSennel(root) {
  const bin = path.join(root, ".test-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "sennel"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SENNEL)} "$@"\n`, { mode: 0o755 });
  return bin;
}

function completedAction() {
  return {
    taskId: null, step: null, action: "completed", instructions: null, context: null,
    output_schema: null, requires_approval: false,
    directive: { kind: "completed", terminal: true, requiresUserAction: false },
  };
}

async function measureWorker(evidence, route, operation) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const response = await operation();
  evidence.calls.push({
    route, startedAt, durationMs: Date.now() - started,
    responseChars: typeof response === "string" ? response.length : null,
    response: typeof response === "string" ? response : null,
  });
  return response;
}

it("real agent completes a synthetic bounded draft Gate repair through canonical spec publication", { timeout: 720_000 }, async () => {
  const root = createTmpDir("draft-gate-repair-agent-");
  const originalPath = process.env.PATH;
  const retained = RETAINED_SNAPSHOT ? JSON.parse(fs.readFileSync(RETAINED_SNAPSHOT, "utf8")) : null;
  assert.equal(Boolean(RETAINED_SNAPSHOT), Boolean(RETAINED_REPOSITORY), "retained replay needs both snapshot and repository");
  const evidence = {
    version: 1,
    scenario: retained
      ? "controlled retained #521 replay: current draft plus original Gate observations; not exact historical replay"
      : "synthetic draft Gate repair; not a historical #521 replay",
    profile: PROFILE_KEY, calls: [], result: "incomplete",
  };
  try {
    if (retained) fs.cpSync(RETAINED_REPOSITORY, root, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
    initGitRepo(root);
    if (!retained) fs.writeFileSync(path.join(root, "README.md"), "draft Gate repair agent fixture\n");
    commitAll(root, "draft Gate repair agent fixture");
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "config.json"), `${JSON.stringify(config(), null, 2)}\n`);
    process.env.PATH = `${installSennel(root)}${path.delimiter}${originalPath}`;
    const specId = "521-draft-gate-repair-agent";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-521-draft-gate-repair", issue: 521,
      request: retained?.issue ?? "Preserve Issue #521 while repairing bounded draft Gate evidence.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(retained?.draft ?? canonicalDraftDocument({ goal: "The retained behavior is incomplete.", questions: [] }), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const observations = retained?.observations ?? [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-521",
      where: { file: "draft.json", locator: "goal" }, observed: "The retained behavior must be explicit.",
      severity: "blocking", refs: ["R-521"],
    }];
    const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId })
      .select({ observations, issueLogId: retained?.historicalGateEntry?.issueLogId ?? "issue-521-draft-gate" });
    const request = scenario.createRequest();
    assert.deepEqual(request.payloads.map((payload) => payload.rule.logicalName), ["draft-gate-repair.json"]);
    const agent = new Agent({ config: config(), paths: { root, agentWorkDir: path.join(root, ".tmp") },
      registry: new ProviderRegistry(config().agent.providers), logger: new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: false }), flowManager: manager });
    await measureWorker(evidence, "draft-gate-repair", () => agent.call([
      "Read the worker handoff request at", request.requestPath,
      "and its immutable inputs. Write and seal exactly the declared draft-gate-repair.json payload.",
      "Use its inputRevision, every persisted observation fingerprint, and one bounded replacement at an allowed authoring path.",
      "Do not write draft.json or gate-repair-report.json. Run the exact sealCommand from the request.",
    ].join(" "), { commandId: "flow.dispatch", executionWorkDir: root }));
    const reconciled = scenario.coordinator.reconcile({ ctx: scenario.ctx, request });
    assert.equal(reconciled.completed, true, JSON.stringify(reconciled));
    const repairedDraft = JSON.parse(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).bytes);
    if (!retained) assert.notEqual(repairedDraft.goal, "The retained behavior is incomplete.");
    if (!retained) assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "draft.gate.repair"), true);
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "plan.gate.repair.outcome"), true);

    const agentContainer = new Container();
    agentContainer.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
    agentContainer.register("mainRoot", root);
    agentContainer.register("config", config());
    agentContainer.register("inWorktree", false);
    agentContainer.register("flowManager", manager);
    agentContainer.register("agent", agent);
    const context = () => ({ root, mainRoot: root, executionRoot: root, specId, phase: "draft", config: config(), flowManager: manager, flowState: manager.loadReadOnly(specId), agent });
    const claim = await new RunClaimNextActionCommand().execute(context());
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const coverage = new RunReviewCommand();
    coverage.container = agentContainer;
    const coverageResult = await measureWorker(evidence, "draft-coverage-review", () => coverage.execute(context()));
    assert.notEqual(coverageResult.ok, false, JSON.stringify(coverageResult));
    await FLOW_COMMANDS.run.review.post(context(), coverageResult);
    const gateClaim = await new RunClaimNextActionCommand().execute(context());
    assert.equal(gateClaim.ok, true, JSON.stringify(gateClaim));
    const gateResult = await new RunGateCommand().execute({ ...context(), skipGuardrail: true });
    if (retained) assert.ok(["pass", "fail"].includes(gateResult.result), JSON.stringify(gateResult));
    else assert.equal(gateResult.result, "pass", JSON.stringify(gateResult));
    evidence.gateResult = gateResult.result;
    await FLOW_COMMANDS.run.gate.post(context(), gateResult);
    const specAction = await new (await import("../../src/flow/lib/get-next-action.js")).default().execute(context());
    assert.equal(specAction.step, "spec");
    const specClaim = await new RunClaimNextActionCommand().execute(context());
    assert.equal(specClaim.ok, true, JSON.stringify(specClaim));
    if (retained) {
      const retainedState = manager.loadReadOnly(specId);
      evidence.snapshotDigest = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(RETAINED_SNAPSHOT)).digest("hex");
      evidence.observationCount = observations.length;
      evidence.specClaim = { currentNodeId: retainedState.currentNodeId, status: findStepById(retainedState.steps, "spec").status };
      assert.equal(observations.length, 17);
      assert.equal(retainedState.currentNodeId, "spec");
      evidence.result = "passed";
      return;
    }
    const dispatcher = new RunDispatchCommand({
      nextAction: {
        async run(container, input) {
          const action = await new (await import("../../src/flow/lib/get-next-action.js")).default().run(container, input);
          return action.step === "spec-review" ? completedAction() : action;
        },
      },
      agent,
      repositoryFingerprint: () => "draft-gate-repair-agent-spec",
      leaseFactory: () => ({ acquire() {}, release() {} }),
    });
    dispatcher.container = agentContainer;
    const dispatchResult = await measureWorker(evidence, "spec", () => dispatcher.execute({
      ...context(), expectRunId: "run-521-draft-gate-repair", expectSpec: specId,
      _envelopeType: "run", _envelopeKey: "dispatch",
    }));
    assert.equal(dispatchResult.dispatch?.boundary, "completed", JSON.stringify(dispatchResult));
    const state = manager.loadReadOnly(specId);
    assert.equal(state.issue, 521);
    assert.equal(findStepById(state.steps, "draft-gate").status, "done");
    assert.equal(findStepById(state.steps, "spec").status, "done");
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "spec.record"), true);
    const canonicalSpec = JSON.parse(manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate" }).bytes);
    assert.match(canonicalSpec.goal, /non-interactive worker/);
    evidence.result = "passed";
  } finally {
    const evidencePath = process.env.SENNEL_DRAFT_GATE_REPAIR_EVIDENCE;
    if (evidencePath) {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.env.PATH = originalPath;
    removeTmpDir(root);
  }
});
