import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../src/lib/flow-target-guard.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../src/flow/lib/get-next-action.js";
import SetApprovalCommand from "../../src/flow/lib/set-approval.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { CanonicalTestArtifactStore } from "../../src/flow/lib/canonical-test-artifacts.js";
import { TEST_REVIEW_REPAIR_BATCH_LIMITS } from "../../src/flow/lib/test-review-repair.js";
import { RequirementTestArtifactStore } from "../../src/flow/lib/requirement-test-store.js";
import { ReviewWorkUnit } from "../../src/flow/lib/review-work-unit.js";
import { sealWorkerArtifactHandoff } from "../../src/flow/lib/worker-artifact-handoff.js";
import { parseTestReviewFindings } from "../../src/flow/commands/review.js";
import { CanonicalFlowFixture } from "./infrastructure/flow-setup.js";
import { removeTmpDir } from "./builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "./infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake, requestInput, requestPayloadPath } from "./infrastructure/flow-dispatch-scenario.js";

/** Real phase composition. Only the external worker, Review process and AI Gate provider are fake.
 * No lifecycle resolver, canonical publication, receipt, promotion or transition is fabricated.
 * Upstream Draft is immutable fixture setup; Spec itself is produced by its registered dispatcher.
 */
export class RequirementTestPhaseScenario {
  static create(t, options = {}) {
    const scenario = new RequirementTestPhaseScenario(options);
    t.after(() => scenario.close());
    scenario.initialize();
    return scenario;
  }

  constructor(options) {
    this.options = options;
    this.specId = "904-requirement-phase";
    this.requests = [];
    this.downstreamReviews = [];
    this.reviews = [];
    this.dispatches = [];
    this.reviewWorkUnits = new Map();
    this.resultEvidence = new Map();
    this.root = fixtureRepository("requirement-test-phase-");
    this.agent = { call: (prompt, options) => this.worker(prompt, options) };
  }

  initialize() {
    this.reload();
    fs.mkdirSync(path.join(this.root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(this.root, ".sennel", "guardrail.json"), workerArtifactJson({ guardrails: [{
      id: "PHASE-SPEC", title: "Executable requirement", body: "Each requirement states the behavior and its verification.",
      meta: { phase: ["spec"], category: "requirements" },
    }] }));
    if (this.options.continueImplementation) {
      fs.mkdirSync(path.join(this.root, ".sennel", "output"), { recursive: true });
      fs.writeFileSync(path.join(this.root, ".sennel", "output", "analysis.json"), "{}\n");
      fs.writeFileSync(path.join(this.root, "package.json"), workerArtifactJson({ type: "module", scripts: { test: "node --test project-tests/smoke.test.js" } }));
      fs.mkdirSync(path.join(this.root, "project-tests"), { recursive: true });
      fs.writeFileSync(path.join(this.root, "project-tests", "smoke.test.js"), "import test from 'node:test'; test('project starts', () => {});\n");
    }
    new CanonicalFlowFixture({ flowManager: this.manager, specId: this.specId,
      runId: "run-requirement-phase", request: "Preserve Requirement tests through approval, Gate and implementation.",
      autoApprove: this.options.autoApprove ?? false,
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("spec");
    this.gateProvider = installGateProviderFake((prompt, options) => {
      const selected = this.options.gateResponse?.(prompt, options, this);
      if (selected !== null && selected !== undefined) return selected;
      const required = options.jsonSchema?.required ?? [];
      if (required.includes("evaluations")) {
        const ids = options.jsonSchema?.properties?.evaluations?.items?.properties?.guardrail_id?.enum ?? [];
        return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({
          guardrail_id, result: "pass", reason: "Scenario accepts the configured guardrail.",
        })) });
      }
      return JSON.stringify({ observations: [], ...(required.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
    });
    const original = childProcess.spawnSync;
    this.reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) return original(command, args, options);
      if (this.options.continueImplementation && (options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY || this.current() === "impl-review")) {
        this.downstreamReviews.push(this.current());
        return original(process.execPath, [fileURLToPath(new URL("./requirement-phase-review-worker.js", import.meta.url))], options);
      }
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const nodeId = this.current();
      if (nodeId === "test-review") {
        this.reviewWorkUnits.set(work.manifest().attemptId, Object.freeze({ manifest: work.manifest(), seal: null }));
        this.options.beforeReview?.(work, this);
      }
      if (nodeId === "spec-review") {
        const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
        const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"), workerArtifactJson(new SpecReviewDelta({
          version: 2, stage: "spec-review", identity: review.identity.toJSON(), baseReviewDigest: review.digest,
          findings: [], operations: [],
        }).toJSON()));
      } else {
        assert.equal(nodeId, "test-review", "scenario only fakes the external Spec and Requirement Review processes");
        const revision = JSON.parse(options.env.SENNEL_REVIEW_TEST_ARTIFACT_REVISION);
        this.reviews.push(revision);
        const response = this.options.reviewResponse?.(this.reviews.length, revision, options.env)
          ?? { verdict: this.options.reviewVerdict ?? "PASS", blockingFindings: [], advisoryFindings: [] };
        const parsed = parseTestReviewFindings(JSON.stringify({ blockingFindings: response.blockingFindings ?? [], advisoryFindings: response.advisoryFindings ?? [] }));
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "requirement-test-review.json"), workerArtifactJson({
          ...(response.toolingOutcome ? { toolingOutcome: response.toolingOutcome } : { verdict: response.verdict }),
          blockingFindings: parsed.blocking.map((finding) => finding.toJSON()),
          advisoryFindings: parsed.advisory.map((finding) => finding.toJSON()),
        }));
      }
      const manifest = work.manifest();
      if (nodeId === "test-review") this.reviewWorkUnits.set(manifest.attemptId, Object.freeze({ manifest, seal: null }));
      const seal = work.seal();
      if (nodeId === "test-review") this.reviewWorkUnits.set(manifest.attemptId, Object.freeze({ manifest, seal }));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    syncBuiltinESMExports();
  }

  spec() {
    const base = validWorkerHandoffTaskSpec();
    return { ...base,
      requirements: this.options.requirements ?? [{ id: "R1", desc: "Report the required behavior.", task_ids: ["T1"], preimplementation_test_expectation: "fail" }],
      tasks: (this.options.tasks ?? base.tasks).map((task) => ({ ...task, test_strategy: "Run the Requirement test and inspect its assertion." })),
    };
  }

  async worker(_prompt, options) {
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const invocationId = options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    this.requests.push(request);
    if (request.stepId === "spec") {
      fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson(this.spec()));
    } else if (["spec-triage", "spec-repair"].includes(request.stepId)) {
      const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
      fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
        version: 2, stage: request.stepId, identity: review.identity.toJSON(), baseReviewDigest: review.digest,
        findings: [], operations: [], ...(request.stepId === "spec-repair" ? { scopeExpansions: [] } : {}),
      }));
    } else if (request.stepId === "spec-gate-repair") {
      // Consume the real dispatcher-selected capability bundle. The isolated
      // Spec repair fixture also creates/reserves its own handoff, so it cannot
      // be used inside this already admitted external worker invocation.
      const context = requestInput(request, "spec-gate-repair-context.json").document;
      assert.equal(context.mode, "repair");
      const groups = SpecGateRepairBundle.fromJSON(context.bundle).selections().map((selection) => {
        const target = selection.unit.findings[0].targets[0];
        const range = selection.ranges.find((entry) => entry.path === `requirements[${target.id}].desc` && entry.writable);
        assert.ok(range);
        return { findingIdentities: selection.unit.findings.map((entry) => entry.identity),
          operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
            edits: [{ startByte: Buffer.byteLength(range.value, "utf8"), endByte: Buffer.byteLength(range.value, "utf8"),
              replacement: " The Spec Gate observation is addressed." }],
            reason: `Address the exact Spec Gate ${target.id} observation.` }] };
      });
      fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision, groups,
      }));
    } else if (["test-generate", "test-repair"].includes(request.stepId)) {
      const input = requestInput(request, "spec.json").document;
      const requirementId = input.requirements[0].id;
      const target = path.join(requestPayloadPath(request, "spec-tests"), `${requirementId.toLowerCase()}.test.js`);
      const source = this.options.testSource?.(requirementId, request, this)
        ?? (request.stepId === "test-repair" && fs.existsSync(target)
          ? fs.readFileSync(target, "utf8") : requirementTestSource(requirementId, input.expectation));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source + (request.stepId === "test-repair" ? `// addressed batch ${request.testReviewRepair.batch.batchId}\n` : ""));
      if (request.stepId === "test-generate") {
        for (const [relativePath, bytes] of Object.entries(this.options.supportFiles ?? {})) {
          const supportPath = path.join(requestPayloadPath(request, "spec-tests"), "support", relativePath);
          fs.mkdirSync(path.dirname(supportPath), { recursive: true });
          fs.writeFileSync(supportPath, bytes);
        }
      }
    } else if (["implement", "task-impl", "impl-triage", "impl-repair"].includes(request.stepId)) {
      if (request.stepId === "implement") {
        this.implementationInput = requestInput(request, "spec.json");
        if (!this.options.continueImplementation) throw new Error("SCENARIO_IMPLEMENT_INPUT_OBSERVED");
      }
      assert.equal(this.options.continueImplementation, true);
      if (["implement", "task-impl"].includes(request.stepId)) {
        fs.mkdirSync(path.join(this.root, "src"), { recursive: true });
        const file = request.stepId === "implement" ? "implementation.js" : `task-${request.taskId}.js`;
        fs.writeFileSync(path.join(this.root, "src", file), "export const implemented = true;\n");
      }
      // Source workers return the existing source response contract; the dispatcher
      // owns their source checkpoint, seal, materialization and settlement.
      return JSON.stringify({ version: 1, stepId: request.stepId, completionStatus: "done", issues: [],
        overview: request.stepId === "task-impl" ? { modules: ["Implemented behavior"], data_flow: [], decisions: [] } : null,
        triage: request.stepId === "impl-triage" ? { version: 1, dispositions: [] } : null,
        repair: request.stepId === "impl-repair" ? { version: 1, findings: [], summary: "No remaining implementation findings.", recurrenceResolutions: [] } : null,
        noChangeReason: null,
      });
    } else throw new Error(`Unexpected phase worker: ${request.stepId}`);
    await this.options.beforeSeal?.(request, this);
    sealWorkerArtifactHandoff({ requestPath, invocationId, mainRoot: this.root, flowManager: this.manager });
    await this.options.afterSeal?.(request, this);
    return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
  }

  reload({ versionStoreFaultInjector = null } = {}) {
    this.manager = new FlowManager({ root: this.root, mainRoot: this.root, inWorktree: false, specId: this.specId, versionStoreFaultInjector });
    return this;
  }
  context() {
    return { root: this.root, executionRoot: this.root, mainRoot: this.root, specId: this.specId,
      flowManager: this.manager, flowState: this.manager.loadReadOnly(this.specId) };
  }
  current() { return this.manager.canonicalState(this.specId).current?.at(-1) ?? this.manager.canonicalState(this.specId).nextAction().nodeId; }
  async next() { return new GetNextActionCommand().execute(this.context()); }
  approve() {
    return new SetApprovalCommand().execute({ ...this.context(), approved: true,
      confirmedAt: "2026-10-05T00:00:00.000Z", notes: "Requirement tests approved in phase scenario." });
  }
  async dispatch(limit = 1) {
    const command = new RunDispatchCommand({ agent: this.agent, maxDispatches: limit, ...(this.options.handoffCoordinator ? { handoffCoordinator: this.options.handoffCoordinator } : {}) });
    command.container = dispatchContainer({ root: this.root, flowManager: this.manager, agent: this.agent });
    const result = await command.execute({ ...this.context(),
      expectBinding: FlowTargetBinding.capture({ flowState: this.manager.loadReadOnly(this.specId),
        mainRoot: this.root, authorityRoot: this.root }).serialize(), _envelopeType: "run", _envelopeKey: "dispatch" });
    this.dispatches.push(result);
    // Fault scenarios restore their intentionally unavailable read boundary before
    // evidenceFor() performs its audit. Do not let observation mask that command error.
    if (!result.errors?.some((entry) => entry.code !== "FLOW_DISPATCH_LIMIT_REACHED")) this.captureResultEvidence();
    return result;
  }
  async advanceTo(stepId, limit = 32) {
    for (let index = 0; index < limit; index += 1) {
      if (this.manager.canonicalState(this.specId).current?.at(-1) === stepId) return this;
      const result = await this.dispatch();
      if (this.manager.canonicalState(this.specId).current?.at(-1) === stepId) return this;
      assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED",
        `normal dispatcher must reach ${stepId}: ${JSON.stringify({ errors: result.errors, dispatch: result.dispatch ?? result.data?.dispatch, step: result.nextAction?.step ?? result.data?.nextAction?.step, failure: this.manager.canonicalState(this.specId).attempt?.failure })}`);
    }
    assert.fail(`dispatcher did not reach ${stepId} in ${limit} actions`);
  }
  /** Read-only audit snapshots. They are never fed into a production producer or transition. */
  captureResultEvidence() {
    const activities = this.manager.activityLedger(this.specId);
    for (const activity of activities) {
      if (!activity.result?.stepResult || this.resultEvidence.has(activity.id)) continue;
      if (!["approval", "test-generate", "test-review", "test-repair", "test-gate"].includes(activity.nodeId)) continue;
      const read = (logicalKey, parameters) => this.manager.readArtifact({ specId: this.specId,
        logicalKey, parameters, consumerNodeId: activity.nodeId, optional: true });
      const evidence = { activity };
      if (activity.nodeId === "test-review" && [
        "test-review-execution-required", "test-review-passed", "test-review-advisory", "test-review-rejected",
      ].includes(activity.result.stepResult.kind)) {
        const workUnit = this.reviewWorkUnits.get(activity.attemptId) ?? null;
        const artifact = read("test.requirement.review");
        let reviewEvidence = null;
        if (artifact !== null) {
          const normalized = new CanonicalTestArtifactStore({ flowManager: this.manager,
            state: this.manager.loadReadOnly(this.specId) }).readCurrentAttempt({
            logicalKey: "test.requirement.review", consumerNodeId: "test-review",
          });
          const digest = normalized.payload.canonicalEvidence?.identity.evidenceDigest;
          if (digest) {
            const resolved = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "test-review", digest });
            reviewEvidence = this.manager.readCanonicalTransitionView({ specId: this.specId, read: (view) => {
              const descriptor = view.catalog.resolve(resolved.relativePath);
              return { descriptor, relativePath: resolved.relativePath, bytes: view.readCatalogedArtifact(descriptor) };
            } });
          }
        }
        evidence.review = Object.freeze({ workUnit, artifact, evidence: reviewEvidence });
      }
      if (activity.nodeId === "test-gate" && [
        "test-gate-compatible", "test-gate-incompatible", "test-gate-tooling-unavailable",
      ].includes(activity.result.stepResult.kind)) {
        evidence.gate = Object.freeze({ artifact: read("test.requirement.gate") });
      }
      this.resultEvidence.set(activity.id, Object.freeze(evidence));
    }
  }
  evidenceFor(activity) {
    this.captureResultEvidence();
    const evidence = this.resultEvidence.get(activity.id);
    assert.ok(evidence, `saved ${activity.nodeId} Activity must have an observed publication snapshot`);
    return evidence;
  }
  artifact(logicalKey, parameters = undefined) {
    return this.manager.readArtifact({ specId: this.specId, logicalKey, parameters, consumerNodeId: this.current(), optional: true });
  }
  candidate(requirementId) {
    const state = this.manager.canonicalState(this.specId);
    const store = new RequirementTestArtifactStore({ flowManager: this.manager, state });
    const item = store.readPlan(this.current()).artifact.plan.workItem(requirementId);
    return store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: this.current() });
  }
  plan() {
    return new RequirementTestArtifactStore({ flowManager: this.manager, state: this.manager.canonicalState(this.specId) })
      .readPlan(this.current()).artifact.plan;
  }
  snapshot() {
    return { state: this.manager.canonicalState(this.specId).toJSON(),
      activities: this.manager.activityLedger(this.specId), catalog: this.manager.artifactCatalog(this.specId).toJSON() };
  }
  close() {
    this.reviewProcess?.mock.restore();
    syncBuiltinESMExports();
    this.gateProvider?.mock.restore();
    removeTmpDir(this.root);
  }
}

export function requirementTestSource(requirementId, expectation = "fail") {
  return `// spec: ${requirementId}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${requirementId}: required behavior', () => { ${expectation === "fail" ? "assert.fail('expected before implementation');" : "assert.equal(1, 1);"} });\n`;
}

/** A genuine external Review rejection; the parent derives identity and repair scope. */
export function rejectFirstRequirementReview(index, revision) {
  return index === 1 ? {
    verdict: "REJECTED",
    blockingFindings: [{ title: "Assert the complete behavior", target: revision.requirementId,
      issue: "The assertion omits a required behavior.", requiredChange: "Add the missing behavior assertion.",
      whyBlocking: "The Requirement needs executable evidence.", testPaths: [`${revision.requirementId.toLowerCase()}.test.js`] }],
    advisoryFindings: [],
  } : { verdict: "PASS", blockingFindings: [], advisoryFindings: [] };
}

/** External Review response that makes the production planner choose bounded batches. */
export function rejectFirstRequirementReviewBatches(count = TEST_REVIEW_REPAIR_BATCH_LIMITS.findingCount + 1) {
  return (index, revision) => {
    const response = rejectFirstRequirementReview(index, revision);
    if (index !== 1) return response;
    return { ...response, blockingFindings: Array.from({ length: count }, (_, findingIndex) => ({
      ...response.blockingFindings[0], title: `Missing behavior ${findingIndex}`,
      issue: `Required behavior ${findingIndex} has no assertion.`, requiredChange: `Add assertion ${findingIndex}.`,
    })) };
  };
}
