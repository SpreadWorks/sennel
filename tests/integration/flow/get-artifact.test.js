import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Container } from "../../../src/lib/container.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { AuthoritativeSpecRecord, FlowVersionMigrationClassifier } from "../../../src/lib/flow-version.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { ArtifactViewService } from "../../../src/flow/lib/artifact-view-service.js";
import { splitArtifactViewSummary } from "../../../src/flow/lib/artifact-view-summary.js";
import { flattenSteps } from "../../../src/flow/lib/step-tree.js";
import {
  CurrentFlowStateAdoptionBoundary,
  CurrentFlowVersionMigrationOutputBuilder,
  CurrentFlowVersionSemanticValidator,
} from "../../../src/flow/lib/current-flow-state.js";
import GetArtifactCommand, {
  ArtifactViewRequest,
} from "../../../src/flow/lib/get-artifact.js";
import {
  canonicalImplReviewArtifact,
  CanonicalFlowFixture,
  confirmCanonicalFixtureStep,
  FreshFlowFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function root() {
  const value = createTmpDir("get-artifact-");
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

function taskRecord() {
  return {
    id: "T1",
    title: "Artifact view task",
    goal: "Render task details inline.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
    acceptance: ["Task data is visible."],
  };
}

function specRecord(goal) {
  return {
    goal,
    background: "Keep source text unchanged.",
    scope: { in: ["Read the canonical Version"], out: ["Change Flow state"] },
    constraints: ["Node built-ins only."],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "R1", desc: "Show this requirement.", task_ids: ["T1"] }],
    acceptance_criteria: ["The display is deterministic."],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

function fixture(directory, { specId, goal, active = false } = {}) {
  const flowManager = makeFlowManager(directory);
  const created = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    specRecord: specRecord(goal),
  }).create().addTask(taskRecord());
  if (active) created.registerActive();
  return { flowManager, created };
}

function finalizeFixture(flowManager, created) {
  for (const step of created.leaves()) created.settle(step.id);
  flowManager.finalizeFlow(created.specId);
  return created;
}

function finalizeMigratedVersion(flowManager, specId) {
  for (const step of flattenSteps(flowManager.loadReadOnly(specId).steps)) {
    if (["done", "skipped"].includes(step.status)) continue;
    confirmCanonicalFixtureStep(flowManager, specId, step.id);
  }
  flowManager.finalizeFlow(specId);
}

class CountingAgent {
  constructor() {
    this.resolveCalls = 0;
    this.calls = 0;
  }

  resolve() {
    this.resolveCalls += 1;
    return {
      providerKey: "codex",
      profileKey: "codex/gpt-5.6-terra-medium",
      profile: { command: "codex", args: [] },
    };
  }

  async call() {
    this.calls += 1;
    return "{}";
  }
}

class QueuedSummaryAgent extends CountingAgent {
  constructor(responses) {
    super();
    this.responses = [...responses];
  }

  async call() {
    this.calls += 1;
    if (this.responses.length === 0) throw new Error("unexpected artifact summary call");
    return this.responses.shift();
  }
}

function attemptHistory(logicalKey, payload) {
  return Buffer.from(`${JSON.stringify({
    attempts: [{ attempt: 1, artifact: { logicalKey, payload } }],
  }, null, 2)}\n`, "utf8");
}

function exactAcceptanceChunkResponse(units) {
  const source = (kind) => units.filter((unit) => unit.kind === kind);
  const excerpt = (unit) => ({ sourceRefs: [unit.id], excerpt: unit.markdown });
  const result = {};
  const collections = [
    ["requirementJudgment", "requirements", "requirementId", true],
    ["mechanicalBlocker", "mechanicalBlockers", "blockerId", false],
    ["hardBlocker", "hardBlockers", "blockerId", false],
    ["deferredFinding", "deferredFindings", "findingId", false],
    ["remainingRisk", "remainingRisks", "riskId", false],
  ];
  for (const [kind, property, identity, status] of collections) {
    const values = source(kind);
    if (values.length === 0) continue;
    result[property] = values.map((unit) => ({
      [identity]: unit.identity,
      ...(status ? { status: unit.status } : {}),
      ...excerpt(unit),
    }));
  }
  return JSON.stringify(result);
}

function acceptanceSummaryResponses(fullView) {
  const summaryKinds = new Set([
    "requirementJudgment", "mechanicalBlocker", "hardBlocker", "deferredFinding", "remainingRisk",
  ]);
  return splitArtifactViewSummary(fullView)
    .filter((chunk) => chunk.units.some((unit) => summaryKinds.has(unit.kind)))
    .map((chunk) => exactAcceptanceChunkResponse(chunk.units));
}

function exactSpecChunkResponse(units) {
  const source = (kind) => units.filter((unit) => unit.kind === kind);
  const excerpt = (unit) => ({ sourceRefs: [unit.id], excerpt: unit.markdown });
  const result = {};
  for (const [kind, property] of [
    ["purpose", "purpose"],
    ["scope", "scope"],
    ["constraints", "constraints"],
    ["openQuestions", "openQuestions"],
  ]) {
    const [unit] = source(kind);
    if (unit) result[property] = excerpt(unit);
  }
  const requirements = source("requirement");
  if (requirements.length > 0) {
    result.requirements = requirements.map((unit) => ({ requirementId: unit.identity, ...excerpt(unit) }));
  }
  const tasks = source("task");
  if (tasks.length > 0) {
    result.tasks = tasks.map((unit) => ({ taskId: unit.identity, ...excerpt(unit) }));
  }
  return JSON.stringify(result);
}

function specSummaryResponses(fullView) {
  const summaryKinds = new Set(["purpose", "scope", "constraints", "openQuestions", "requirement", "task"]);
  return splitArtifactViewSummary(fullView)
    .filter((chunk) => chunk.units.some((unit) => summaryKinds.has(unit.kind)))
    .map((chunk) => exactSpecChunkResponse(chunk.units));
}

function migratedVersionFixture(directory, { specId, goal }) {
  const flowManager = makeFlowManager(directory);
  const target = flowManager.canonicalVersionLocation(1, { specId });
  const source = path.join(directory, "legacy-flow-source");
  fs.mkdirSync(source, { recursive: true });
  // The migration boundary transforms the two legacy authorities into the
  // canonical Version; no derived Markdown file is admitted or retained.
  fs.writeFileSync(path.join(source, "flow.json"), "{}\n");
  fs.writeFileSync(path.join(source, "spec.json"), "{}\n");
  const definition = buildCurrentFlowDefinition();
  const validator = new CurrentFlowVersionSemanticValidator({ definition });
  const boundary = new CurrentFlowStateAdoptionBoundary({ definition });
  const state = boundary.createFresh({
    flowId: `flow-${specId}`,
    flowVersionId: `flow-v1-${specId}`,
    runId: `run-${specId}`,
    specId,
    request: "Render a migrated canonical Version.",
    execution: { mode: "direct" },
    policy: { autoApprove: false, nonblocking: null },
  });
  const spec = new AuthoritativeSpecRecord({
    ...specRecord(goal),
    id: specId,
    requirements: [],
    tasks: [],
  });
  const migration = new FlowVersionMigrationClassifier({
    target,
    semanticValidator: validator,
    outputBuilder: new CurrentFlowVersionMigrationOutputBuilder({ semanticValidator: validator }),
  }).inspect(source).plan().outputFixture({ state, spec }).materialize();
  return { flowManager, migration };
}

function acceptanceFixture(directory, { specId, missingFingerprint = false } = {}) {
  const flowManager = makeFlowManager(directory);
  const created = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    specRecord: specRecord("Render every cataloged acceptance source."),
  }).create().addTask(taskRecord()).registerActive();
  created.activate("impl-review");
  const repairFingerprint = "a".repeat(64);
  const implReview = canonicalImplReviewArtifact(created.state(), { blockingFindings: [{
    findingKey: "source-F1",
    title: "Cataloged acceptance source",
    failureMode: "unresolved_acceptance_source",
    file: null,
    issue: "An original cataloged finding remains visible.",
    detail: "This detail comes from the authoritative implementation-review attempt.",
    suggestion: "Resolve the source finding before a later review.",
    requirementId: "R1",
    guardrailId: null,
    disposition: "informational",
    rationale: "The cataloged acceptance source remains unresolved.",
  }] });
  const sourceFinding = implReview.blockingFindings[0];
  const deferred = {
    findingId: "F1",
    sourceStep: "impl-review",
    sourceArtifact: "steps/impl/review/result.json",
    sourceFindingId: sourceFinding.findingId,
    finalDisposition: "still_open",
    evidenceRefs: [`steps/impl/review/result.json#${sourceFinding.findingId}`],
  };
  const state = created.state();
  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "impl-review",
    artifactWrites: [
      {
        logicalKey: "impl.review",
        mediaType: "application/json",
        bytes: attemptHistory("impl.review", implReview),
      },
      {
        logicalKey: "flow.findings",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify({
          version: 2,
          entries: [{
            findingId: deferred.findingId,
            sourceStep: deferred.sourceStep,
            sourceArtifact: deferred.sourceArtifact,
            sourceFindingId: deferred.sourceFindingId,
            runId: state.runId,
            fingerprint: missingFingerprint ? "d".repeat(64) : sourceFinding.fingerprint,
            disposition: "deferred",
            rationale: "The finding remains visible for an explicit decision.",
            retryExhausted: true,
            attempts: 5,
            round: 1,
            completionKind: "deferred",
            finalDisposition: deferred.finalDisposition,
          }],
        }, null, 2)}\n`, "utf8"),
      },
    ],
  });
  created.activate("acceptance-review");
  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "acceptance-review",
    artifactWrites: [{
      logicalKey: "acceptance.review",
      mediaType: "application/json",
      bytes: attemptHistory("acceptance.review", {
        version: 2,
        repairFingerprint,
        mechanicalBlockers: [],
        hardBlockers: [deferred],
        requirementJudgments: [{
          requirementId: "R1",
          status: "notVerifiable",
          requestRefs: ["flow.request"],
          requirementRefs: ["spec.json#R1"],
          diffRefs: [],
          repairRefs: ["acceptance:no-repair"],
          testRefs: [],
          missingEvidence: ["An explicit risk decision is required."],
        }],
        deferredFindings: [deferred],
        userDecision: null,
        verdict: "user_decision_required",
      }),
    }],
  });
  return { flowManager, created, repairFingerprint };
}

function publishAcceptanceDecision({ flowManager, created, repairFingerprint }) {
  created.activate("acceptance-decision");
  const review = flowManager.readArtifact({
    specId: created.specId,
    logicalKey: "acceptance.review",
    consumerNodeId: "acceptance-decision",
  });
  flowManager.publishArtifacts({
    specId: created.specId,
    nodeId: "acceptance-decision",
    artifactWrites: [{
      logicalKey: "acceptance.decision",
      mediaType: "application/json",
      bytes: attemptHistory("acceptance.decision", {
        version: 1,
        choice: "accept_risk_and_continue",
        decidedAt: "2026-08-15T00:00:00.000Z",
        acceptanceReviewAttempt: 1,
        acceptanceReviewDigest: review.descriptor.hash,
        repairFingerprint,
      }),
    }],
  });
}

function commandContainer(directory, flowManager, agent = new CountingAgent()) {
  const container = new Container();
  container.register("paths", { root: directory });
  container.register("mainRoot", directory);
  container.register("config", { lang: "en" });
  container.register("flowManager", flowManager);
  container.register("inWorktree", false);
  container.register("agent", agent);
  return { container, agent };
}

function input(values = {}) {
  return {
    _envelopeType: "get",
    _envelopeKey: "artifact",
    logicalKey: "spec.record",
    mode: "full",
    ...values,
  };
}

describe("flow get artifact", () => {
  it("accepts only a registered target, an explicit mode, and a complete positive Version pair", () => {
    assert.throws(() => new ArtifactViewRequest({ logicalKey: "flow.activities", mode: "full" }), /unsupported artifact/i);
    assert.throws(() => new ArtifactViewRequest({ logicalKey: "spec.record" }), /--mode is required/i);
    assert.throws(() => new ArtifactViewRequest({ logicalKey: "spec.record", mode: "other" }), /full or summary/i);
    assert.throws(() => new ArtifactViewRequest({ logicalKey: "spec.record", mode: "full", specId: "001-only" }), /provided together/i);
    assert.throws(() => new ArtifactViewRequest({ logicalKey: "spec.record", mode: "full", specId: "001-test", version: "1.5" }), /positive integer/i);
    assert.throws(() => new ArtifactViewRequest({
      logicalKey: "spec.record",
      mode: "full",
      specId: "001-test",
      version: "1",
      expectBinding: "active-only",
    }), /cannot use active Flow guards/i);
  });

  it("renders an active canonical target and stores one metadata-hidden full cache", async () => {
    const directory = root();
    const { flowManager, created } = fixture(directory, {
      specId: "001-active",
      goal: "Active canonical display.",
      active: true,
    });
    const { container } = commandContainer(directory, flowManager);

    const result = await new GetArtifactCommand().run(container, input());
    const cachePath = path.join(created.location().directory, ".runtime", "views", "spec.record.full.md");

    assert.equal(result.ok, true);
    assert.equal(result.type, "get");
    assert.equal(result.key, "artifact");
    assert.match(result.data.markdown, /Active canonical display\./);
    assert.equal(result.data.markdown.startsWith("<!--"), false);
    assert.match(fs.readFileSync(cachePath, "utf8"), /^<!-- sennel-flow-artifact-view /);
  });

  it("reads exactly the supplied completed Version without touching an ambient active Flow", async () => {
    const directory = root();
    const active = fixture(directory, {
      specId: "001-active",
      goal: "This active Flow must not be selected.",
      active: true,
    });
    const completed = fixture(directory, {
      specId: "002-completed",
      goal: "This exact completed Version is displayed.",
    });
    finalizeFixture(completed.flowManager, completed.created);
    const { container } = commandContainer(directory, active.flowManager);
    const originalLoad = active.flowManager.load;
    const originalResolveActive = active.flowManager.resolveActiveFlow;
    active.flowManager.load = () => { throw new Error("ambient active Flow must not be loaded"); };
    active.flowManager.resolveActiveFlow = () => { throw new Error("ambient active Flow must not be inferred"); };
    try {
      const result = await new GetArtifactCommand().run(container, input({
        specId: "002-completed",
        version: "1",
      }));
      assert.equal(result.ok, true);
      assert.match(result.data.markdown, /This exact completed Version is displayed\./);
      assert.equal(fs.existsSync(path.join(completed.created.location().directory, ".runtime", "views", "spec.record.summary.md")), false);
    } finally {
      active.flowManager.load = originalLoad;
      active.flowManager.resolveActiveFlow = originalResolveActive;
    }
  });

  it("renders and summarizes a materialized migrated Version with no legacy spec.md", async () => {
    const directory = root();
    const { flowManager, migration } = migratedVersionFixture(directory, {
      specId: "002-migrated",
      goal: "A migrated Version is rendered from its cataloged spec record.",
    });
    finalizeMigratedVersion(flowManager, "002-migrated");
    const location = migration.location;
    assert.equal(fs.existsSync(path.join(location.directory, "spec.md")), false);
    const persistedSpec = JSON.parse(fs.readFileSync(location.specFile, "utf8"));
    assert.equal(Object.hasOwn(persistedSpec, "id"), false);
    assert.equal(Object.hasOwn(persistedSpec, "specId"), false);

    const fullForSummary = new ArtifactViewService({ config: { lang: "en" }, flowManager }).full({
      logicalKey: "spec.record",
      specId: "002-migrated",
      version: 1,
    });
    const agent = new QueuedSummaryAgent(specSummaryResponses(fullForSummary.fullView));
    const { container } = commandContainer(directory, flowManager, agent);
    const command = new GetArtifactCommand();
    const full = await command.run(container, input({ specId: "002-migrated", version: "1" }));
    const summary = await command.run(container, input({
      mode: "summary",
      specId: "002-migrated",
      version: "1",
    }));

    assert.equal(full.ok, true);
    assert.match(full.data.markdown, /migrated Version is rendered/i);
    assert.equal(summary.ok, true);
    assert.match(summary.data.markdown, /migrated Version is rendered/i);
    assert.equal(agent.calls > 0, true);
  });

  it("rejects an explicit active Version before cache or summary agent work", async () => {
    const directory = root();
    const active = fixture(directory, {
      specId: "002-not-completed",
      goal: "An active Version is not historical display authority.",
      active: true,
    });
    const { container, agent } = commandContainer(directory, active.flowManager);
    const result = await new GetArtifactCommand().run(container, input({
      mode: "summary",
      specId: "002-not-completed",
      version: "1",
    }));

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ARTIFACT_VIEW_READ_FAILED");
    assert.match(result.errors[0].messages.join("\n"), /requires a finalized Version/i);
    assert.equal(agent.resolveCalls, 0);
    assert.equal(fs.existsSync(path.join(active.created.location().directory, ".runtime", "views")), false);
  });

  it("rejects a partial or guarded completed selector before cache or agent work", async () => {
    const directory = root();
    const active = fixture(directory, {
      specId: "001-active",
      goal: "Ambient Flow.",
      active: true,
    });
    const completed = fixture(directory, {
      specId: "002-completed",
      goal: "Historical Flow.",
    });
    const { container, agent } = commandContainer(directory, active.flowManager);
    const cacheDirectory = path.join(completed.created.location().directory, ".runtime", "views");
    const command = new GetArtifactCommand();

    for (const request of [
      input({ specId: "002-completed" }),
      input({ specId: "002-completed", version: "not-an-integer" }),
      input({ specId: "002-completed", version: "1", expectBinding: "active-only" }),
    ]) {
      const result = await command.run(container, request);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "ARGS_ERROR");
    }
    assert.equal(fs.existsSync(cacheDirectory), false);
    assert.equal(agent.resolveCalls, 0);
    assert.equal(agent.calls, 0);
  });

  it("rejects a same-identity stale active binding before cache or summary-agent work", async () => {
    const directory = root();
    const { flowManager, created } = fixture(directory, {
      specId: "001-active",
      goal: "Guarded active Flow.",
      active: true,
    });
    const staleAuthority = root();
    const state = created.state();
    const binding = new FlowTargetBinding({
      runId: state.runId,
      issue: state.issue,
      specId: state.specId,
      authority: {
        mode: "direct",
        mainRoot: staleAuthority,
        executionRoot: staleAuthority,
        featureBranch: null,
        baseBranch: null,
      },
    }).serialize();
    const { container, agent } = commandContainer(directory, flowManager);
    const result = await new GetArtifactCommand().run(container, input({
      mode: "summary",
      expectBinding: binding,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ACTIVE_FLOW_MISMATCH");
    assert.equal(fs.existsSync(path.join(created.location().directory, ".runtime", "views")), false);
    assert.equal(agent.resolveCalls, 0);
    assert.equal(agent.calls, 0);
  });

  it("reads a real cataloged acceptance attempt and its declared dynamic source, decision, and structured summary", async () => {
    const directory = root();
    const acceptance = acceptanceFixture(directory, {
      specId: "003-acceptance-with-decision",
    });
    const { flowManager, created, repairFingerprint } = acceptance;
    const undecidedContainer = commandContainer(directory, flowManager).container;
    const undecided = await new GetArtifactCommand().run(undecidedContainer, input({ logicalKey: "acceptance.review" }));
    assert.equal(undecided.ok, true, JSON.stringify(undecided));
    assert.match(undecided.data.markdown, /Undecided/);

    publishAcceptanceDecision({ flowManager, created, repairFingerprint });
    const exactFull = new ArtifactViewService({ config: { lang: "en" }, flowManager })
      .full({ logicalKey: "acceptance.review", activeState: created.state() });
    const agent = new QueuedSummaryAgent(acceptanceSummaryResponses(exactFull.fullView));
    const { container } = commandContainer(directory, flowManager, agent);
    const command = new GetArtifactCommand();

    const full = await command.run(container, input({ logicalKey: "acceptance.review" }));
    const summary = await command.run(container, input({ logicalKey: "acceptance.review", mode: "summary" }));

    assert.equal(full.ok, true);
    assert.match(full.data.markdown, /Judgment R1/);
    assert.match(full.data.markdown, /An original cataloged finding remains visible\./);
    assert.match(full.data.markdown, /The finding remains visible for an explicit decision\./);
    assert.match(full.data.markdown, /Accept risk and continue/);
    assert.match(full.data.markdown, /2026-08-15T00:00:00\.000Z/);
    assert.equal(summary.ok, true);
    assert.match(summary.data.markdown, /Judgment R1/);
    assert.match(summary.data.markdown, /Deferred finding F1/);
    assert.equal(agent.calls > 0, true);

    const cacheDirectory = path.join(created.location().directory, ".runtime", "views");
    const cacheBeforeCorruption = fs.readdirSync(cacheDirectory).sort().map((name) => [
      name,
      fs.readFileSync(path.join(cacheDirectory, name), "utf8"),
    ]);
    fs.appendFileSync(created.location().artifact("impl.review"), "corrupt source bytes");
    const noCallAgent = new QueuedSummaryAgent([]);
    const failedContainer = commandContainer(directory, flowManager, noCallAgent).container;
    const failed = await new GetArtifactCommand().run(failedContainer, input({
      logicalKey: "acceptance.review",
      mode: "summary",
    }));

    assert.equal(failed.ok, false);
    assert.equal(failed.errors[0].code, "ARTIFACT_VIEW_READ_FAILED");
    assert.equal(noCallAgent.resolveCalls, 0);
    assert.equal(noCallAgent.calls, 0);
    const cacheAfterCorruption = fs.readdirSync(cacheDirectory).sort().map((name) => [
      name,
      fs.readFileSync(path.join(cacheDirectory, name), "utf8"),
    ]);
    assert.deepEqual(cacheAfterCorruption, cacheBeforeCorruption);
  });

  it("rejects an artifact view reference whose authoritative fingerprint is absent from its source", async () => {
    const directory = root();
    const { flowManager } = acceptanceFixture(directory, {
      specId: "004-acceptance-missing-fingerprint",
      missingFingerprint: true,
    });
    const { container, agent } = commandContainer(directory, flowManager);

    const result = await new GetArtifactCommand().run(container, input({ logicalKey: "acceptance.review" }));

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ARTIFACT_VIEW_READ_FAILED");
    assert.equal(agent.resolveCalls, 0);
    assert.equal(agent.calls, 0);
  });

});
