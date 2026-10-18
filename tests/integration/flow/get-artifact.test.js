import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

import { Container } from "../../../src/lib/container.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { AuthoritativeSpecRecord, FlowVersionMigrationClassifier } from "../../../src/lib/flow-version.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { ArtifactViewService } from "../../../src/flow/lib/artifact-view-service.js";
import { splitArtifactViewSummary } from "../../../src/flow/lib/artifact-view-summary.js";
import {
  CurrentFlowStateAdoptionBoundary,
  CurrentFlowVersionMigrationOutputBuilder,
  CurrentFlowVersionSemanticValidator,
} from "../../../src/flow/lib/current-flow-state.js";
import GetArtifactCommand, {
  ArtifactViewRequest,
} from "../../../src/flow/lib/get-artifact.js";
import {
  CanonicalFlowFixture,
  FreshFlowFixture,
  makeFlowManager,
  replaceCatalogedArtifactForCorruptionFixture,
} from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";
import { fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import SetAcceptanceDecisionCommand from "../../../src/flow/lib/set-acceptance-decision.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow } from "../../../src/flow/lib/nonblocking.js";
import { recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking-decision.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";

const roots = [];
const acceptanceSeedScope = new SeedCleanupScope(after, mock);
let acceptanceDynamicSeed;

function root() {
  const value = fixtureRepository("get-artifact-");
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
    requirements: [{ id: "R1", desc: "Show this requirement.", testable: false, task_ids: ["T1"] }],
    acceptance_criteria: ["The display is deterministic."],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
  };
}

function fixture(directory, { specId, goal, active = false } = {}) {
  const flowManager = makeFlowManager(directory, { specId });
  const created = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    execution: { mode: "direct", baseBranch: "main" },
    specRecord: specRecord(goal),
  }).create().addTask(taskRecord());
  if (active) created.registerActive();
  return { flowManager, created };
}

async function finalizeFixture(flowManager, created) {
  const source = "version-view.js";
  created.registerActive();
  await created.activateWithProducers("finalize-cleanup", {
    implementationFiles: new Map([["R1", [source]]]),
    sourceMutations: new Map([["implement", () => {
      fs.writeFileSync(path.join(flowManager.executionRoot(), source), "export const exactVersionView = true;\n");
    }]]),
  });
  created.settle("finalize-cleanup");
  flowManager.finalizeFlow(created.specId);
  return created;
}

async function finalizeMigratedVersion(flowManager, specId) {
  return finalizeFixture(flowManager, CanonicalFlowFixture.fromExisting({ flowManager, specId }));
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
  const flowManager = makeFlowManager(directory, { specId });
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
    execution: { mode: "direct", baseBranch: "main" },
    policy: { autoApprove: false, nonblocking: null },
  });
  const spec = new AuthoritativeSpecRecord({
    ...specRecord(goal),
    id: specId,
    requirements: [{ id: "R1", desc: "Show this requirement.", testable: false, task_ids: ["T1"] }],
    tasks: [taskRecord()],
  });
  const migration = new FlowVersionMigrationClassifier({
    target,
    semanticValidator: validator,
    outputBuilder: new CurrentFlowVersionMigrationOutputBuilder({ semanticValidator: validator }),
  }).inspect(source).plan().outputFixture({ state, spec }).materialize();
  return { flowManager, migration };
}

async function acceptanceFixture(t, { specId: requestedSpecId, missingFingerprint = false } = {}) {
  acceptanceDynamicSeed ??= AcceptancePhaseScenario.seed(acceptanceSeedScope, {
    frontier: "acceptance-decision",
    seedSpecId: requestedSpecId,
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    gateResponse(_prompt, options, active) {
      if (active.current() !== "spec-gate") return null;
      const observation = options.jsonSchema?.properties?.observations?.items;
      const requirementIds = observation?.properties?.requirementId?.enum ?? [];
      const sourceRefs = observation?.properties?.sourceRef?.enum ?? [];
      if (requirementIds.length && sourceRefs.length) return JSON.stringify({ observations:
        requirementIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({ requirementId, sourceRef,
          support: [], contradictions: ["An original cataloged finding remains visible."], unresolved: [] }))) });
      const references = observation?.properties?.requirementRef?.enum ?? [];
      const target = { entity: "requirement", id: "R1", field: "desc" };
      return JSON.stringify({ observations: references.includes("PHASE-SPEC") ? [{
        failureMode: "guardrail-violation", requirementRef: "PHASE-SPEC",
        where: { file: "spec.json", locator: "requirements.R1.desc" },
        observed: "An original cataloged finding remains visible.", targets: [target],
        allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
      }] : [], ...(options.jsonSchema?.required?.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
    },
    acceptanceResponse: (_ordinal, active) => acceptanceProviderResponse(active,
      { status: "notVerifiable", disposition: "still_open" }),
    prepare: async (scenario) => {
      await scenario.dispatch(64);
      scenario.reload();
      const stopped = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "spec-gate" });
      assert.equal(scenario.current(), "spec-gate");
      assert.equal(stopped.result.kind, "spec-gate-blocked");
      assert.equal(stopped.result.error.data.reason, "cycle-limit");
      activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
        reason: "Retain the unresolved Spec observation for Acceptance." });
      const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
      recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "continue",
        reason: "The finding remains visible for an explicit decision.",
        remainingRisk: "Acceptance must decide the unresolved Spec Gate observation.",
        expectEvidenceDigest: context.evidenceDigest });
      await scenario.advanceTo("acceptance-decision");
      scenario.reload();

    },
  });
  const scenario = AcceptancePhaseScenario.fromSeed(t, await acceptanceDynamicSeed);
  const specId = scenario.specId;
  const flowManager = scenario.manager;
  const created = CanonicalFlowFixture.fromExisting({ flowManager, specId });
  const retained = flowManager.readArtifact({ specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review" });
  const findings = JSON.parse(retained.bytes.toString("utf8"));
  assert.equal(findings.entries.length, 1);
  const finding = findings.entries[0];
  assert.equal(finding.sourceStep, "spec-gate");
  if (missingFingerprint) {
    // Fault injection follows a real producer and its real Acceptance consumer.
    // Keep the source intact, but point the retained identity at no source finding.
    finding.fingerprint = "d".repeat(64);
    replaceCatalogedArtifactForCorruptionFixture(flowManager, specId, "flow.findings",
      Buffer.from(JSON.stringify(findings) + "\n"));
  }
  return { root: scenario.root, flowManager, created, scenario, finding };
}

async function publishAcceptanceDecision({ scenario, flowManager, created }) {
  await new SetAcceptanceDecisionCommand().execute({ ...scenario.context(), choice: "accept_risk_and_continue" });
  const decision = flowManager.readArtifact({ specId: created.specId, logicalKey: "acceptance.decision", consumerNodeId: "report" });
  return CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "acceptance.decision", bytes: decision.bytes }).current.payload;
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
    await finalizeFixture(completed.flowManager, completed.created);
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
    await finalizeMigratedVersion(flowManager, "002-migrated");
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

  it("reads a real cataloged acceptance attempt and its declared dynamic source, decision, and structured summary", async (t) => {
    const acceptance = await acceptanceFixture(t, {
      specId: "003-acceptance-with-decision",
    });
    const { root: directory, flowManager, created, finding } = acceptance;
    const undecidedContainer = commandContainer(directory, flowManager).container;
    const undecided = await new GetArtifactCommand().run(undecidedContainer, input({ logicalKey: "acceptance.review" }));
    assert.equal(undecided.ok, true, JSON.stringify(undecided));
    assert.match(undecided.data.markdown, /Undecided/);

    const decision = await publishAcceptanceDecision(acceptance);
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
    assert.ok(full.data.markdown.includes(finding.rationale));
    assert.match(full.data.markdown, /Accept risk and continue/);
    assert.ok(full.data.markdown.includes(decision.decidedAt));
    assert.equal(summary.ok, true);
    assert.match(summary.data.markdown, /Judgment R1/);
    assert.ok(summary.data.markdown.includes("Deferred finding " + finding.findingId));
    assert.equal(agent.calls > 0, true);

    const cacheDirectory = path.join(created.location().directory, ".runtime", "views");
    const cacheBeforeCorruption = fs.readdirSync(cacheDirectory).sort().map((name) => [
      name,
      fs.readFileSync(path.join(cacheDirectory, name), "utf8"),
    ]);
    fs.appendFileSync(created.location().artifact("spec.gate"), "corrupt source bytes");
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

  it("rejects an artifact view reference whose authoritative fingerprint is absent from its source", async (t) => {
    const { root: directory, flowManager } = await acceptanceFixture(t, {
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
