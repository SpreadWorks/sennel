import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { CanonicalReviewWorkUnit } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { DraftReviewExecutionTargetIdentity } from "../../../src/flow/definition.js";
import { draftStepRegistration, prepareDraftReviewBinding } from "../../../src/flow/engine/composition/draft.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument, setupFlowConfig } from "./flow-setup.js";
import { fixtureRepository, installGateProviderFake } from "./flow-dispatch-scenario.js";
import { completeDraftWorkerThroughStep, prepareConditionalDraftWorkerThroughStep } from "./draft-worker-step.js";
import { completeSpecGateRepairHandoff } from "./spec-gate-repair-scenario.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "./worker-artifact.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";

const PACKAGE_ROOT = new URL("../../../", import.meta.url).pathname;

/** Public details belonging to one saved Activity and its response closure. */
class QueryActivityObservation {
  constructor(response, activityId) {
    this.item = response.items.find((entry) => entry.activity.id === activityId);
    assert.ok(this.item, `saved ${activityId} is returned`);
    this.entities = Object.fromEntries(["evaluations", "findings", "repairs"].map((group) => [group,
      this.item.detailRefs[group].map((detailId) => {
        const entity = response.entities[group].find((entry) => entry.id === detailId);
        assert.ok(entity, `${detailId} belongs to the closure`);
        return entity;
      })]));
  }
}

export function queryActivityDetails(response, activityId) {
  return new QueryActivityObservation(response, activityId);
}

/** Preserve every historical meaning while allowing a later captured file hash. */
export function queryHistoricalEntitySemantics(entity) {
  const value = structuredClone(entity);
  for (const source of [value.source, ...value.supportingSources]) {
    // A ledger prefix or append-only Attempt history has new enclosing bytes
    // after publication. Its observation address and body remain unchanged.
    // Immutable evidence/audit sources retain their hash and artifact ID too.
    if (source.format === "jsonl" || source.jsonPointer?.startsWith("/attempts/")) {
      delete source.hash;
      delete source.artifactId;
    }
  }
  return value;
}

/** Real Draft persistence; only the external Review provider output is replaced. */
export class QueryDraftReviewScenario {
  constructor(t, specId) {
    this.root = fixtureRepository("query-draft-review-producer-");
    t.after(() => removeTmpDir(this.root));
    // Query snapshot IDs bind the executable's source signature. Freeze this
    // package per scenario so concurrent development cannot change a cursor.
    this.cliPackage = createTmpDir("query-draft-review-cli-");
    t.after(() => removeTmpDir(this.cliPackage));
    fs.cpSync(path.join(PACKAGE_ROOT, "src"), path.join(this.cliPackage, "src"), { recursive: true });
    fs.copyFileSync(path.join(PACKAGE_ROOT, "package.json"), path.join(this.cliPackage, "package.json"));
    if (process.env.SENNEL_QUERY_HISTORY_DEBUG === "1") {
      const helperPath = "src/flow/query-spec-gate-repair-details.js";
      const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const sourceHash = hash(path.join(PACKAGE_ROOT, helperPath));
      const copiedHash = hash(path.join(this.cliPackage, helperPath));
      process.stdout.write(`# ${JSON.stringify({ diagnostic: "query-helper-source-copy", helperPath,
        sourceHash, copiedHash, equal: sourceHash === copiedHash, copiedPath: path.join(this.cliPackage, helperPath) })}\n`);
      assert.equal(copiedHash, sourceHash, "the query helper's actual copied bytes match the fixed source");
    }
    this.specId = specId;
    setupFlowConfig(this.root, "en");
    this.reload();
    new CanonicalFlowFixture({ flowManager: this.manager, specId, runId: `run-${specId}`,
      request: "Preserve the saved Draft Review meaning for a query consumer.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    this.coordinator = new WorkerArtifactHandoffCoordinator();
  }

  reload() {
    this.manager = new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false, specId: this.specId });
    return this.manager;
  }

  get ctx() {
    return { root: this.root, mainRoot: this.root, executionRoot: this.root, specId: this.specId, flowManager: this.manager };
  }

  invocation(step) {
    return { id: `query-${step}`, target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step } } };
  }

  async draft() {
    const request = this.coordinator.createRequest({ ctx: this.ctx, state: this.manager.loadReadOnly(this.specId), invocation: this.invocation("draft") });
    fs.writeFileSync(request.payloadPath("draft.json"), workerArtifactJson(canonicalDraftDocument()));
    sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
    const result = await completeDraftWorkerThroughStep({ coordinator: this.coordinator, ctx: this.ctx, request });
    assert.equal(result.stepResult.kind, "draft-created");
    this.reload();
    this.manager.beginNextAction(this.specId);
  }

  async refine() {
    this.manager.beginNextAction(this.specId);
    assert.equal(this.manager.canonicalState(this.specId).current.at(-1), "draft-refine");
    const result = await prepareConditionalDraftWorkerThroughStep({ coordinator: this.coordinator, ctx: this.ctx,
      state: this.manager.loadReadOnly(this.specId), invocation: this.invocation("draft-refine") });
    assert.equal(result.stepResult.kind, "draft-refine-completed");
    this.reload();
    this.manager.beginNextAction(this.specId);
  }

  async checkpoint(phase) {
    const state = this.manager.loadReadOnly(this.specId);
    const unit = new CanonicalReviewWorkUnit({ flowManager: this.manager, state, phase,
      executionRoot: this.root, treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) });
    unit.declareCanonicalInputs();
    const manifest = unit.workUnit.manifest();
    const binding = await prepareDraftReviewBinding({ flowManager: this.manager, state, phase });
    const executionBinding = this.manager.draftStepExecutionState({ binding }).reviewBinding({
      manifestDigest: manifest.digest, inputDigest: manifest.inputDigest,
      target: new DraftReviewExecutionTargetIdentity(manifest.target.toJSON()),
    });
    const prepared = await draftStepRegistration(`${phase}-review`).create({ flowManager: this.manager,
      state, binding, executionBinding });
    const result = await prepared.step.execute();
    assert.equal(result.kind, `${phase}-review-execution-required`);
    this.reload();
  }

  async review(phase, { verdict = "PASS", blocking = [], advisory = [], repairs = [], terminal = true, beforeOutput = null } = {}) {
    assert.equal(this.manager.canonicalState(this.specId).current.at(-1), `${phase}-review`);
    const command = new RunReviewCommand({ resolveTreeSha: () => "a".repeat(40), resolveTargetStateDigest: () => "b".repeat(64),
      runCommand: async (_command, _args, options) => {
        if (beforeOutput !== null) await beforeOutput(this);
        const work = ReviewWorkUnit.fromEnvironment(options.env);
        const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
        fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
          version: 2, phase, sourceDraft: "draft.json", sourceDraftRevision: source.revision,
          generatedAt: "2026-10-13T00:00:00.000Z", verdict, summary: `${phase} saved ${verdict} review.`,
          blockingFindings: blocking, advisoryFindings: advisory, repairTargets: repairs,
        }));
        work.seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = { ...this.ctx, phase: "draft", config: {}, flowState: this.manager.loadReadOnly(this.specId) };
    const result = await command.execute(ctx);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    if (terminal) await FLOW_COMMANDS.run.review.post(ctx, result);
    else {
      // Stop after the registered publication Step, the first durable stage
      // of the normal Review post handler, before its terminal Step executes.
      const binding = await prepareDraftReviewBinding({ flowManager: this.manager,
        state: this.manager.canonicalState(this.specId), phase });
      const prepared = await draftStepRegistration(`${phase}-review`).create({ ctx, binding, publicationResult: result });
      assert.equal((await prepared.step.execute()).kind, `${phase}-review-execution-required`);
    }
    this.reload();
    return result;
  }

  async resumeReview(phase) {
    const command = new RunReviewCommand({ runCommand: () => assert.fail("publication recovery must not invoke a provider") });
    const result = await command.execute({ ...this.ctx, phase: "draft", config: {}, flowState: this.manager.loadReadOnly(this.specId) });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    const binding = await prepareDraftReviewBinding({ flowManager: this.manager,
      state: this.manager.canonicalState(this.specId), phase });
    const prepared = await draftStepRegistration(`${phase}-review`).create({ flowManager: this.manager, binding, commandResult: result });
    assert.equal((await prepared.step.execute()).kind, `${phase}-review-passed`);
    this.reload();
  }

  async runGate({ phase, respond, expectedResult }) {
    this.manager.beginNextAction(this.specId);
    assert.equal(this.manager.canonicalState(this.specId).current.at(-1), `${phase}-gate`);
    const provider = installGateProviderFake(respond);
    let result;
    try {
      const ctx = { ...this.ctx, phase, level: "semantic", config: {},
        flowState: this.manager.loadReadOnly(this.specId) };
      result = await new RunGateCommand().execute(ctx);
      assert.equal(result.result, expectedResult, JSON.stringify(result));
      await FLOW_COMMANDS.run.gate.post(ctx, result);
    } finally { provider.mock.restore(); }
    this.reload();
    return result;
  }

  async gate() {
    await this.runGate({ phase: "draft", expectedResult: "pass",
      respond: () => JSON.stringify({ observations: [], evaluationUnavailable: null }) });
    this.manager.beginNextAction(this.specId);
  }

  async specGate({ respond, expectedResult }) {
    return this.runGate({ phase: "spec", respond, expectedResult });
  }

  async specGateRepair(replacement, { edits = null } = {}) {
    assert.equal(this.manager.canonicalState(this.specId).current.at(-1), "spec-gate-repair");
    const completed = await completeSpecGateRepairHandoff({ ctx: this.ctx,
      invocation: this.invocation("spec-gate-repair"), coordinator: this.coordinator, replacement, edits });
    this.reload();
    return completed;
  }

  async spec(document = validWorkerHandoffTaskSpec()) {
    const request = this.coordinator.createRequest({ ctx: this.ctx, state: this.manager.loadReadOnly(this.specId),
      invocation: this.invocation("spec") });
    fs.writeFileSync(request.payloadPath("spec.json"), workerArtifactJson(document));
    sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
    const prepared = await specStepRegistration("spec").create({ ctx: this.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: this.coordinator });
    assert.equal((await prepared.step.execute()).kind, "spec-created");
    this.reload();
    this.manager.beginNextAction(this.specId);
  }

  async specReview(findings) {
    const command = new RunReviewCommand({ resolveTreeSha: () => "a".repeat(40), resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(_command, _args, options) {
        const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
        const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
        const delta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: review.identity.toJSON(),
          baseReviewDigest: review.digest, findings, operations: [] });
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"), workerArtifactJson(delta.toJSON()));
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = { ...this.ctx, phase: "spec", config: {}, flowState: this.manager.loadReadOnly(this.specId) };
    const result = await command.execute(ctx);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    await FLOW_COMMANDS.run.review.post(ctx, result);
    this.reload();
  }

  async specWorker(stepId, { findings = [], operations = [] } = {}) {
    this.manager.beginNextAction(this.specId);
    assert.equal(this.manager.canonicalState(this.specId).current.at(-1), stepId);
    const request = this.coordinator.createRequest({ ctx: this.ctx, state: this.manager.loadReadOnly(this.specId),
      invocation: this.invocation(stepId) });
    const review = new CanonicalSpecReview(request.inputs.find((entry) => entry.name === "review.json").document);
    fs.writeFileSync(request.payloadPath("review.delta.json"), workerArtifactJson({ version: 2, stage: stepId,
      identity: review.identity.toJSON(), baseReviewDigest: review.digest, findings, operations }));
    sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
    const prepared = await specStepRegistration(stepId).create({ ctx: this.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: this.coordinator });
    const result = await prepared.step.execute();
    this.reload();
    return result;
  }

  protectedState() {
    return { state: this.manager.canonicalState(this.specId).toJSON(),
      catalog: this.manager.artifactCatalog(this.specId).toJSON(), ledger: this.manager.activityLedger(this.specId) };
  }

  cli(request) {
    return spawnSync(process.execPath, [path.join(this.cliPackage, "src", "sennel.js"), "flow", "query"], { cwd: this.root,
      env: { ...process.env, SENNEL_WORK_ROOT: this.root, SENNEL_SOURCE_ROOT: this.root },
      input: JSON.stringify(request), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  }

  async query(input) {
    const read = await this.captureQuery(input);
    assert.equal(read.version.projectionError, null, JSON.stringify(read.version.projectionError));
    return read.version.response;
  }

  async captureQuery(input, { fixedSource = false } = {}) {
    const api = fixedSource ? await import(pathToFileURL(path.join(this.cliPackage, "src", "flow", "query.js")).href)
      : { CanonicalFlowVersionReader, QueryRequest };
    const captured = await new api.CanonicalFlowVersionReader({ repositoryRoot: this.root })
      .read(this.specId, 1, new api.QueryRequest(input));
    if (fixedSource) await this.diagnoseQueryCapture(captured);
    return captured;
  }

  async diagnoseQueryCapture(captured) {
    if (process.env.SENNEL_QUERY_HISTORY_DEBUG !== "1" || captured.version.projectionError === null) return;
    const version = captured.version;
    const error = version.projectionError;
    const activity = version.activities.find((entry) => entry.id === error.referenceId && entry.nodeId === "spec-gate-repair");
    if (!activity) return;
    const api = await import(pathToFileURL(path.join(this.cliPackage, "src", "lib", "flow-artifact-contract.js")).href);
    const operationApi = await import(pathToFileURL(path.join(this.cliPackage, "src", "flow", "lib", "spec-repair-operations.js")).href);
    const auditPath = api.FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.audit", { attemptId: activity.attemptId }).relativePath;
    const auditBytes = version.artifactBytes.get(auditPath);
    if (!auditBytes) {
      process.stdout.write(`# ${JSON.stringify({ diagnostic: "gate-repair-captured-binding", activityId: activity.id,
        auditPath, hydrated: false, error: error.message })}\n`);
      return;
    }
    const audit = JSON.parse(auditBytes);
    const operationAudit = new operationApi.StoredSpecGateRepairOperationAudit(Object.fromEntries(
      ["version", "phase", "baseRevision", "acceptedGroups", "discardedGroups", "operationDigest", "resultRevision"]
        .map((field) => [field, audit[field]])));
    const descriptor = version.catalog.artifacts.find((entry) => entry.logicalKey === "spec.snapshot" && `sha256:${entry.hash}` === audit.baseRevision);
    const checks = descriptor ? {
      logicalKey: descriptor.logicalKey === "spec.snapshot",
      cardinality: descriptor.cardinality.toString() === "collection",
      canonicalPath: api.FLOW_ARTIFACT_CONTRACTS.require("spec.snapshot").matchesCanonicalPath(descriptor.relativePath),
      hash: descriptor.hash === operationAudit.baseRevision.slice("sha256:".length),
    } : null;
    process.stdout.write(`# ${JSON.stringify({ diagnostic: "gate-repair-captured-binding", activityId: activity.id,
      descriptor: descriptor?.toJSON() ?? null, auditBaseRevision: audit.baseRevision,
      operationAuditBaseRevision: operationAudit.baseRevision, checks, error: error.message })}\n`);
  }
}
