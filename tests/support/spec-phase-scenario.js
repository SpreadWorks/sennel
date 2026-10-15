import { performance } from "node:perf_hooks";
import { CanonicalScenarioSeed } from "./assertions/canonical-persistence.js";
import assert from "node:assert/strict";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { SpecGateRepairProgressReader } from "../../src/flow/lib/spec-gate-repair-progress-reader.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FlowManager } from "../../src/lib/flow-manager.js";
import { container as runtimeContainer } from "../../src/lib/container.js";
import { dispatch as dispatchRegisteredCommand } from "../../src/lib/dispatcher.js";
import { flowCommands } from "../../src/lib/command-registry.js";
import { buildFlowCommandHookContext } from "../../src/flow/lib/flow-context.js";
import { ProcessExecutionRuntime } from "../../src/lib/process-execution-runtime.js";
import { currentRuntimePackage, listRuntimeResources, readRuntimeResource } from "../../src/lib/runtime-package.js";
import { readFlowProcessStops } from "../../src/flow/lib/process-runtime-admission.js";
import { FlowExecutionContract } from "../../src/flow/lib/flow-execution-contract.js";
import { workerProcessStopIdentity } from "../../src/flow/lib/process-runtime-evidence.js";
import { FlowTargetBinding } from "../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import RunReopenDraftCommand from "../../src/flow/lib/run-reopen-draft.js";
import * as gateFacts from "../../src/flow/lib/gate-transition-facts.js";
import SetApprovalCommand from "../../src/flow/lib/set-approval.js";
import { NonBlockingPolicy, activateNonBlockingPolicy, decisionContextForActiveFlow } from "../../src/flow/lib/nonblocking.js";
import { recordNonBlockingDecision } from "../../src/flow/lib/nonblocking-decision.js";
import GetNextActionCommand from "../../src/flow/lib/get-next-action.js";
import GetArtifactCommand from "../../src/flow/lib/get-artifact.js";
import { getStepInstructions } from "../../src/flow/lib/get-step-instructions.js";
import { FLOW_DISPATCH_INVOCATION_ENV } from "../../src/flow/lib/dispatch-invocation.js";
import { readCurrentGateTransitionFacts } from "../../src/flow/lib/gate-transition-facts.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import { CanonicalTestArtifactStore } from "../../src/flow/lib/canonical-test-artifacts.js";
import { CanonicalAcceptanceArtifactStore } from "../../src/flow/lib/canonical-acceptance-artifacts.js";
import { ReviewWorkUnit } from "../../src/flow/lib/review-work-unit.js";
import {
  sealWorkerArtifactHandoff,
} from "../../src/flow/lib/worker-artifact-handoff.js";
import { workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";
import {
  CanonicalFlowFixture, canonicalDraftDocument,
} from "./infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "./builders/tmp-dir.js";
import { installReviewProcessFake } from "./infrastructure/review-process-fake.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "./infrastructure/worker-artifact.js";
import {
  dispatchContainer,
  dispatchFlowCommand,
  fixtureRepository,
  installGateProviderFake,
  requestInput,
  requestPayloadPath,
  requestSpecGateRepairIdentity,
} from "./infrastructure/flow-dispatch-scenario.js";

import { SeedWorkRoot, observeSeedTiming } from "./builders/seed-work-root.js";

function assertSelectedGateInstructions(next) {
  assert.equal(next.instructions.key, "plan.spec-gate");
  assert.match(next.instructions.content, /latest Definition-selected next Action \/ typed directive/);
  assert.match(next.instructions.content, /After execution, refresh next-action and follow its selected directive/);
  assert.doesNotMatch(next.instructions.content, /transition back to `spec`|gate step completes as deferred|Do not proceed until PASS/);
}

function largeRepairValue(prefix) {
  const remainingBytes = 34_522 - Buffer.byteLength(prefix);
  return `${prefix}${"条".repeat(Math.floor(remainingBytes / 3))}${"x".repeat(remainingBytes % 3)}`;
}

async function assertSummaryPreservesPublishedEvidence({ root, specId, flowManager, binding, requirement }) {
  const directory = flowManager.specLocation(specId).directory;
  const snapshot = () => {
    const files = new Map();
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (path.relative(directory, file).split(path.sep).join("/") === ".runtime/views") continue;
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) files.set(path.relative(directory, file), fs.readFileSync(file));
      }
    };
    visit(directory);
    return files;
  };
  const before = snapshot();
  let malformed = true;
  let calls = 0;
  const agent = {
    promptCharacterLimit: 60_000,
    resolve: () => ({ providerKey: "fixture", profileKey: "summary", profile: { args: [] } }),
    call: async (prompt) => {
      calls += 1;
      const records = JSON.parse(prompt.split("Source sections (JSON):\n")[1]);
      const response = {};
      for (const record of records) {
        const excerpt = { sourceRefs: [record.sourceRef], excerpt: record.excerpt };
        if (record.kind === "requirement" || record.kind === "task") {
          const property = record.kind === "requirement" ? "requirements" : "tasks";
          const identity = record.kind === "requirement" ? "requirementId" : "taskId";
          (response[property] ??= []).push({ [identity]: record.identity, ...excerpt });
        } else response[record.kind] = excerpt;
      }
      if (malformed) Object.values(response).flat()[0].excerpt += "changed source";
      return JSON.stringify(response);
    },
  };
  const input = { logicalKey: "spec.record", mode: "summary", expectBinding: binding };
  const container = dispatchContainer({ root, flowManager, agent });
  const rejected = await new GetArtifactCommand().run(container, input);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors[0].code, "ARTIFACT_VIEW_SUMMARY_INVALID");
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(directory, ".runtime/views/spec.record.summary.md")), false);
  malformed = false;
  const summarized = await new GetArtifactCommand().run(container, input);
  assert.equal(summarized.ok, true, JSON.stringify(summarized));
  assert.ok(summarized.data.markdown.includes(requirement));
  assert.deepEqual(snapshot(), before);
  const callCount = calls;
  const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const cached = await new GetArtifactCommand().run(dispatchContainer({ root, flowManager: restored, agent }), input);
  assert.equal(cached.ok, true);
  assert.equal(cached.data.markdown, summarized.data.markdown);
  assert.equal(calls, callCount);
  assert.deepEqual(snapshot(), before);
}


/** Prefix facts come from fresh canonical readback, never replayed fake counters. */
class SpecPhaseHistory {
  static read(manager, specId) { return new this(manager, specId); }
  constructor(manager, specId) {
    const activities = manager.activityLedger(specId);
    const published = activities.filter((entry) => entry.result?.draftSettlementReceipt);
    // Gate repair also persists checkpoint, claim and response-publication
    // receipts. Only the completed handoff carries its worker request reference.
    const workers = published.filter((entry) => ["spec", "spec-triage", "spec-repair", "spec-gate-repair"].includes(entry.nodeId)
      && entry.result.artifactRefs.some((reference) => reference.kind === "worker-handoff-request"));
    this.requestSteps = workers.map((entry) => entry.nodeId);
    this.requestDigests = workers.map((entry) => entry.result.artifactRefs
      .find((reference) => reference.kind === "worker-handoff-request").id);
    assert.equal(new Set(this.requestDigests).size, this.requestDigests.length);
    this.specWorkers = workers.filter((entry) => entry.nodeId === "spec" && entry.result.stepResult.kind === "spec-created").length;
    this.reviews = activities.filter((entry) => entry.reviewPublication?.stage === "spec-review").length;
    this.gates = new Set(published.filter((entry) => entry.nodeId === "spec-gate").map((entry) => entry.attemptId)).size;
    this.repairs = manager.artifactCatalog(specId).artifacts.filter((entry) => entry.logicalKey === "spec.gate.repair.audit").length;
    Object.freeze(this.requestSteps);
    Object.freeze(this.requestDigests);
    Object.freeze(this);
  }
}

/** A separately bootstrapped package creates the historical claim with its own
 * authenticated runtime bytes. The target package never rewrites that claim. */
class PriorSpecWorkerRuntime {
  constructor() {
    this.root = createTmpDir("sennel-spec-prior-runtime-");
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
    const copyResources = (relative) => {
      for (const entry of listRuntimeResources(path.join(sourceRoot, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) copyResources(name);
        else {
          const target = path.join(this.root, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, readRuntimeResource(path.join(sourceRoot, name), null));
        }
      }
    };
    copyResources("src");
    fs.writeFileSync(path.join(this.root, "package.json"), readRuntimeResource(path.join(sourceRoot, "package.json"), null));
    // A harmless byte difference represents the package available to the old
    // dispatcher. Both snapshots otherwise execute the same production code.
    fs.appendFileSync(path.join(this.root, "src/lib/runtime-package.js"), "\n// Prior Spec worker runtime fixture.\n");
    fs.cpSync(path.join(sourceRoot, "tests/support"), path.join(this.root, "tests/support"), { recursive: true });
    for (const name of ["test-environment.js", "test-temporary-root.js"]) {
      fs.copyFileSync(path.join(sourceRoot, "tests", name), path.join(this.root, "tests", name));
    }
  }

  async load() {
    const load = (relative) => import(pathToFileURL(path.join(this.root, relative)).href);
    await load("src/sennel.js");
    const [runtime, manager, container, dispatch, review, handoff] = await Promise.all([
      load("src/lib/runtime-package.js"), load("src/lib/flow-manager.js"), load("src/lib/container.js"),
      load("tests/support/infrastructure/flow-dispatch-scenario.js"),
      load("tests/support/infrastructure/review-process-fake.js"), load("src/flow/lib/worker-artifact-handoff.js"),
    ]);
    this.revision = runtime.currentRuntimePackage().revision;
    assert.notEqual(this.revision, currentRuntimePackage().revision);
    this.FlowManager = manager.FlowManager;
    this.container = container.container;
    this.dispatchFlowCommand = dispatch.dispatchFlowCommand;
    this.dispatchContainer = dispatch.dispatchContainer;
    this.installProvider = dispatch.installGateProviderFake;
    this.installReview = review.installReviewProcessFake;
    this.seal = handoff.sealWorkerArtifactHandoff;
    return this;
  }

  remove() { removeTmpDir(this.root); }
}

/** The real Spec dispatcher scenario, including all original large-input variants. */
export class SpecPhaseScenario {
  static async seed(t) {
    const started = performance.now();
    const producer = await this.run({ retainGateFindings: true }, { strictSeed: true });
    observeSeedTiming("spec-lifecycle-producer", performance.now() - started);
    try {
      const manager = new FlowManager({ root: producer.root, mainRoot: producer.root,
        inWorktree: false, specId: producer.specId });
      return CanonicalScenarioSeed.freeze(t, { root: producer.root, specId: producer.specId, manager,
        prefix: "sennel-spec-phase-seed-", frontier: "spec-gate" });
    } finally { removeTmpDir(producer.root); }
  }

  static async run({ retainGateFindings = false, advisoryRepair = false, largeGateResponse = false,
    largeSpecFile = false, overlongAcceptance = false, largeRepairValues = false, reopenPlanning = false,
    interruptTriage = false, migrateRuntime = false } = {},
    { seed = null, strictSeed = false } = {}) {
    const root = seed ? new SeedWorkRoot(seed.root, { prefix: "sennel-spec-phase-case-" }).root
      : fixtureRepository("spec-artifact-scenario-");
    let retainRoot = false;
    let gateAgentLookup = null;
    let reviewProcess = null;
    let priorRuntime = null;
    try {
      if (!seed) {
        fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
        fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
          guardrails: [{
            id: "SPEC-SHARED",
            title: "Retained plan behavior",
            body: "The plan artifact states every required behavior and its rationale explicitly.",
            meta: { phase: ["spec"], category: "requirements" },
          }],
        }));
      }
      const specId = "802-spec-artifact-scenario";
      let flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      // Immutable upstream inputs are established by the existing fixture's
      // production publication/settlement APIs; all Spec work starts here.
      if (!seed) new CanonicalFlowFixture({
        flowManager, specId, runId: "run-spec-artifact-scenario",
        request: "Preserve repaired Spec requirements in downstream consumers.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        nonblocking: advisoryRepair ? new NonBlockingPolicy({
          activatedStep: "spec-gate", reason: "Use an advisory decision for accepted Spec Gate evidence.",
        }).toJSON() : null,
      }).create().registerActive().activate("spec");
      if (seed) {
        const started = performance.now();
        seed.assertClone(flowManager);
        observeSeedTiming("spec-lifecycle-readback", performance.now() - started);
      }
      const prefix = seed ? SpecPhaseHistory.read(flowManager, specId) : null;
      const requests = [];
      const sealFailures = [];
      let interruptedRequest = null;
      let interruptedRequestPath = null;
      let interruptedPayload = null;
      let interruptionDelivered = false;
      let recoveredTriageConsumed = false;
      let sealHandoff = sealWorkerArtifactHandoff;
      let acceptanceTruncationLogPath = null;
      const overlongAcceptanceText = "受".repeat(501);
      const sharedGuardrail = "SPEC-SHARED";
      const specGateAttempts = new Set();
      let specReviewRuns = 0;
      let specWorkerRuns = 0;
      let draftWorkerRuns = 0;
      let gateRepairWorkerRuns = 0;
      let gateRepairInspectionRuns = 0;
      let gateRepairMutationRuns = 0;
      let gateRepairRequest = null;
      let gateRepairContext = null;
      let gateRepairIdentity = null;
      const gateRepairModes = [];
      const repairedFindingIdentities = new Set();
      const totalSpecWorkers = () => (prefix?.specWorkers ?? 0) + specWorkerRuns;
      const totalReviews = () => (prefix?.reviews ?? 0) + specReviewRuns;
      const totalGates = () => (prefix?.gates ?? 0) + specGateAttempts.size;
      const totalRepairs = () => (prefix?.repairs ?? 0) + gateRepairWorkerRuns;
      const allRequestSteps = () => [...(prefix?.requestSteps ?? []),
        ...requests.filter((request) => request !== interruptedRequest).map((request) => request.stepId)];
      const findingId = "spec-review-requirement";
      const approvedGoal = "Publish the required behavior in the Spec.";
      const reviewedRequirementPrefix = "Retain the repaired Spec requirement in every downstream consumer.";
      const reviewedRequirement = largeRepairValues
        ? largeRepairValue(reviewedRequirementPrefix)
        : reviewedRequirementPrefix;
      const gateRequirement = "R10 must retain its original planned verification wording.";
      const gateRepairPrefix = `${gateRequirement} The Spec Gate observation is addressed. `;
      const gateRepairValue = largeRepairValue(gateRepairPrefix);
      if (largeRepairValues) {
        assert.equal(Buffer.byteLength(reviewedRequirement), 34_522);
        assert.equal(Buffer.byteLength(gateRepairValue), 34_522);
      }
      const gateTarget = { entity: "requirement", id: "R10", field: "desc" };
      const largeFindingIds = Array.from({ length: 8 }, (_, index) => `R${index + 10}`);
      const largeFindingReason = (id, occurrence) => `The planned verification for ${id}, gap ${occurrence + 1}, omits the required cross-section rationale. `
        + Array.from({ length: 47 }, (_, index) => `Evidence ${index + 1} for ${id} compares the stated behavior with its planned check.`).join(" ");
      let largeFirstResponse = null;
      let firstGroupReadFailures = 0;
      async function providerResponse(_prompt, options) {
        if (options.executionEnvironment?.SENNEL_FLOW_HANDOFF_REQUEST
          || options.commandId === "flow.dispatch.nonblocking-decision") {
          return workerResponse(_prompt, options);
        }
        const observationSchema = options.jsonSchema?.properties?.observations?.items;
        const evidenceIds = observationSchema?.properties?.requirementId?.enum ?? [];
        const sourceRefs = observationSchema?.properties?.sourceRef?.enum ?? [];
        const knownIds = observationSchema?.properties?.requirementRef?.enum ?? [];
        const state = flowManager.canonicalState(specId);
        const phase = state.current.at(-1);
        if (reopenPlanning && phase === "draft-gate") {
          return JSON.stringify({ observations: [], evaluationUnavailable: null });
        }
        assert.equal(phase, "spec-gate");
        assertSelectedGateInstructions(await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId,
          flowManager, flowState: flowManager.loadReadOnly(specId),
        }));
        const attempts = specGateAttempts;
        attempts.add(state.attempt.id);
        const fail = retainGateFindings || attempts.size === 1;
        const findingSources = largeGateResponse
          ? largeFindingIds.flatMap((id) => Array.from({ length: 5 }, (_, occurrence) => ({ id, occurrence })))
          : [{ id: "R10", occurrence: 0 }];
        const selected = findingSources.map(({ id, occurrence }) => ({
          failureMode: "guardrail-violation",
          requirementRef: sharedGuardrail,
          where: { file: "spec.json", locator: `requirements.${id}.desc` },
          observed: largeGateResponse ? largeFindingReason(id, occurrence) : retainGateFindings
            ? `Spec behavior ${totalGates()} needs a separate clarification.`
            : "Requirement R10 needs the Gate clarification.",
          targets: [{ ...gateTarget, id }],
          allowedTargets: [{ target: { ...gateTarget, id }, operationKinds: ["edit-text-field"] }],
        }));
        if (evidenceIds.length > 0) {
          return JSON.stringify({ observations: evidenceIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
            requirementId, sourceRef, support: [],
            contradictions: fail && requirementId === sharedGuardrail
              ? [selected[0].observed] : [], unresolved: [],
          }))) });
        }
        if (largeSpecFile && knownIds.includes(sharedGuardrail) && firstGroupReadFailures < 3) {
          firstGroupReadFailures += 1;
          return JSON.stringify({ observations: null, evaluationUnavailable: {
            kind: "file-read-failed", reason: "The first Spec file open failed explicitly.",
          } });
        }
        const response = JSON.stringify({
          observations: fail && knownIds.includes(sharedGuardrail)
            ? selected.map(({ failureMode, requirementRef, where, observed, targets, allowedTargets }) => ({
              failureMode, requirementRef: sharedGuardrail, where, observed, targets, allowedTargets,
            }))
            : [],
          ...(options.jsonSchema?.required?.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}),
        });
        if (largeGateResponse && fail) {
          largeFirstResponse = response;
          assert.ok(response.length > 120_000 && response.length < 160_000, response.length);
        }
        return response;
      }
      gateAgentLookup = installGateProviderFake(providerResponse,
        interruptTriage ? { transportContext: () => ({ root, flowManager }) } : {});
      async function workerResponse(_prompt, options) {
          if (options.commandId === "flow.dispatch.nonblocking-decision") {
            return JSON.stringify({
              choice: "repair",
              reason: "Repair the accepted Spec Gate observation before continuing.",
            });
          }
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const invocationId = options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          if (["spec", "spec-repair", "spec-gate-repair"].includes(request.stepId)) {
            const writingGuidance = getStepInstructions("partials.spec-writing").trim();
            const invocation = JSON.parse(options.executionEnvironment[FLOW_DISPATCH_INVOCATION_ENV]);
            const action = JSON.parse(fs.readFileSync(invocation.actionFilePath, "utf8"));
            assert.ok(action.instructions.content.includes(writingGuidance));
            assert.equal(request.workerInstructions.schemaGuidance.split(writingGuidance).length - 1, 1);
            assert.match(request.workerInstructions.schemaGuidance,
              /Research missing source facts directly in the execution checkout/);
            assert.equal(fs.realpathSync(options.executionWorkDir), fs.realpathSync(root));
            assert.equal(fs.readFileSync(path.join(options.executionWorkDir, "README.md"), "utf8"),
              "flow dispatcher fixture\n");
          }
          requests.push(request);
          writeWorkerPayload(request, options.executionEnvironment);
          if (interruptTriage && request.stepId === "spec-triage" && interruptedRequest === null) {
            interruptedRequest = request;
            interruptedRequestPath = requestPath;
            interruptedPayload = fs.readFileSync(requestPayloadPath(request, "review.delta.json"));
            return JSON.stringify({ interruptedBeforeSeal: true });
          }
          let sealed;
          try {
            sealed = sealHandoff({ requestPath, invocationId, mainRoot: root, flowManager });
          } catch (cause) {
            sealFailures.push({
              stepId: request.stepId,
              code: cause.code ?? null,
              message: cause.message,
              data: cause.data ?? null,
            });
            throw cause;
          }
          if (request.stepId === "spec") acceptanceTruncationLogPath = sealed.acceptanceTruncationLog ?? null;
          return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      }
      function workerAgent(container = runtimeContainer) {
        const managedAgent = container.get("agent");
        if (!interruptTriage) return managedAgent;
        // Reuse the real Agent/provider admission and managed Node transport.
        // Only the external provider's reply is lost after its durable stop.
        const call = managedAgent.call.bind(managedAgent);
        managedAgent.call = async (prompt, options) => {
          const text = await call(prompt, options);
          if (!interruptionDelivered && options.executionEnvironment?.SENNEL_FLOW_HANDOFF_REQUEST === interruptedRequestPath) {
            interruptionDelivered = true;
            throw new Error("Spec triage provider reply was lost before handoff sealing");
          }
          return text;
        };
        return managedAgent;
      }
      let agent = workerAgent();
      function writeWorkerPayload(request, executionEnvironment) {
          if (reopenPlanning && request.stepId === "draft") {
            draftWorkerRuns += 1;
            fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(
              canonicalDraftDocument({ goal: "Reconsider the plan with explicit verification." })));
            return true;
          }
          if (request.stepId === "spec") {
            specWorkerRuns += 1;
            assert.equal(totalSpecWorkers(), reopenPlanning && draftWorkerRuns > 0 ? 2 : 1);
            fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson({
              ...validWorkerHandoffTaskSpec(),
              goal: approvedGoal,
              ...(largeSpecFile ? { background: `Full canonical background: ${"x".repeat(125_000)}` } : {}),
              requirements: [...validWorkerHandoffTaskSpec().requirements.map((requirement) => ({
                ...requirement, ...(largeGateResponse ? { priority: "must" } : {}),
              })),
                ...((largeGateResponse ? largeFindingIds : ["R10"]).map((id) => ({
                  id, desc: id === "R10" ? (reopenPlanning && totalSpecWorkers() === 2
                    ? `${gateRequirement} The regenerated plan requires explicit verification cases.` : gateRequirement) : `Plan verification for ${id}.`,
                  ...(largeGateResponse ? { priority: "must" } : {}),
                  testable: false, task_ids: ["T1"],
                })))],
              tasks: validWorkerHandoffTaskSpec().tasks.map((task) => ({
                ...task,
                test_strategy: "Verify the retained behavior through the focused Flow scenario.",
                ...(overlongAcceptance ? { acceptance: [overlongAcceptanceText] } : {}),
              })),
            }));
            return true;
          }
          if (request.stepId === "spec-gate-repair") {
            gateRepairWorkerRuns += 1;
            const context = requestInput(request, "spec-gate-repair-context.json").document;
            gateRepairModes.push(context.mode);
            assert.equal(context.mode, "repair");
            gateRepairMutationRuns += 1;
            const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections();
            if (largeGateResponse) {
              gateRepairRequest = request;
              gateRepairContext = context;
              gateRepairIdentity = requestSpecGateRepairIdentity(request, executionEnvironment);
            }
            const groups = selected.map((selection) => {
              const finding = selection.unit.findings[0];
              const target = finding.targets[0];
              const range = selection.ranges.find((entry) => entry.path === `requirements[${target.id}].desc` && entry.writable);
              assert.ok(range);
              if (largeGateResponse) {
                assert.ok(largeFindingIds.includes(target.id));
                assert.deepEqual(finding.targets, [{ entity: "requirement", id: target.id, field: "desc" }]);
                assert.equal(selection.unit.findings.length, 5);
                assert.deepEqual(new Set(selection.unit.findings.map((entry) => entry.observed)),
                  new Set(Array.from({ length: 5 }, (_, occurrence) => largeFindingReason(target.id, occurrence))));
                for (const entry of selection.unit.findings) {
                  assert.deepEqual(entry.targets, [target]);
                  assert.deepEqual(entry.allowedTargets, [{ target,
                    operationKinds: ["edit-text-field"] }]);
                  assert.equal(entry.specRevision, context.baseRevision);
                  const key = JSON.stringify(entry.identity);
                  assert.equal(repairedFindingIdentities.has(key), false);
                  repairedFindingIdentities.add(key);
                }
              } else {
                assert.deepEqual(finding.targets, [gateTarget]);
                assert.deepEqual(finding.allowedTargets, [{ target: gateTarget,
                  operationKinds: ["edit-text-field"] }]);
                assert.equal(finding.observed, retainGateFindings
                  ? `Spec behavior ${reopenPlanning ? totalGates() : totalRepairs()} needs a separate clarification.`
                  : "Requirement R10 needs the Gate clarification.");
              }
              assert.equal(context.baseRevision, selection.baseRevision);
              assert.equal(finding.specRevision, context.baseRevision);
              return { findingIdentities: selection.unit.findings.map((entry) => entry.identity),
                operations: [{ kind: "edit-text-field", target: range.target,
                  expectedDigest: range.digest,
                  edits: [{ startByte: largeRepairValues ? 0 : Buffer.byteLength(range.value, "utf8"),
                    endByte: Buffer.byteLength(range.value, "utf8"),
                    replacement: largeRepairValues ? gateRepairValue : " The Spec Gate observation is addressed." }],
                  reason: `Address the exact Spec Gate ${target.id} observation.`,
                }] };
            });
            fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
              version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
              groups,
            }));
            return true;
          }
          if (request.stepId === "spec-triage") {
            const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
            const hasFinding = review.findings.byId(findingId) !== null;
            fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
              version: 2,
              stage: "spec-triage",
              identity: review.identity.toJSON(),
              baseReviewDigest: review.digest,
              findings: hasFinding ? [{
                findingId,
                disposition: "apply",
                evidence: "The reviewed requirement exists in the immutable Spec snapshot.",
                allowedTargets: [{
                  target: { entity: "requirement", id: "R1", field: "desc" },
                  operationKinds: ["replace-entity-field"],
                }],
              }] : [],
              operations: [],
            }));
            return true;
          }
          if (request.stepId === "spec-repair") {
            const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
            const spec = requestInput(request, "spec.json").document;
            const hasFinding = review.findings.byId(findingId) !== null;
            if (interruptTriage && !recoveredTriageConsumed && hasFinding) {
              const finding = review.findings.byId(findingId);
              assert.equal(finding.disposition, "apply");
              assert.equal(finding.evidence, "The reviewed requirement exists in the immutable Spec snapshot.");
              assert.deepEqual(finding.allowedTargets, [{ target: { entity: "requirement", id: "R1", field: "desc" },
                operationKinds: ["replace-entity-field"] }]);
              recoveredTriageConsumed = true;
            }
            fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
              version: 2,
              stage: "spec-repair",
              identity: review.identity.toJSON(),
              baseReviewDigest: review.digest,
              findings: [],
              scopeExpansions: [],
              operations: hasFinding ? [{
                findingIds: [findingId],
                kind: "replace-entity-field",
                target: { entity: "requirement", id: "R1", field: "desc" },
                expectedDigest: crypto.createHash("sha256").update(JSON.stringify(spec.requirements[0].desc)).digest("hex"),
                replacement: reviewedRequirement,
                reason: "Apply the review finding to requirement R1.",
              }] : [],
            }));
            return true;
          }
          throw new Error(`Unexpected Spec worker: ${request.stepId}`);
      }
      function reviewResponse(_command, _args, options) {
        const nodeId = flowManager.canonicalState(specId).current.at(-1);
        const work = ReviewWorkUnit.fromEnvironment(options.env);
        if (reopenPlanning && ["draft-questions-review", "draft-coverage-review"].includes(nodeId)) {
          const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
          fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
            version: 2, phase: nodeId === "draft-questions-review" ? "draft-questions" : "draft-coverage",
            sourceDraft: "draft.json", sourceDraftRevision: source.revision,
            generatedAt: "2026-09-23T00:00:00.000Z", verdict: "PASS", summary: "No review findings.",
            blockingFindings: [], advisoryFindings: [], repairTargets: [],
          }));
        }
        if (nodeId === "spec-review") {
          specReviewRuns += 1;
          const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
          const canonical = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
          if (largeRepairValues && gateRepairWorkerRuns > 0) {
            const reviewSnapshot = flowManager.readArtifact({ specId, logicalKey: "spec.snapshot",
              consumerNodeId: "spec-review", parameters: { revision: canonical.identity.revision.toString() } });
            assert.equal(crypto.createHash("sha256").update(reviewSnapshot.bytes).digest("hex"), canonical.identity.digest);
            const reviewedSpec = JSON.parse(reviewSnapshot.bytes.toString("utf8"));
            assert.equal(reviewedSpec.requirements[0].desc, reviewedRequirement);
            assert.equal(reviewedSpec.requirements.find((entry) => entry.id === "R10").desc, gateRepairValue);
          }
          const delta = new SpecReviewDelta({
            version: 2,
            stage: "spec-review",
            identity: canonical.identity.toJSON(),
            baseReviewDigest: canonical.digest,
            findings: totalReviews() === 1 ? [{
              findingId,
              kind: "blocking",
              title: "Retain the reviewed requirement",
              target: "R1",
              body: "Requirement R1 must describe the retained behavior.",
              issue: "The original requirement omits the review wording.",
              requiredChange: "State the retained behavior in requirement R1.",
              whyBlocking: "The reviewed requirement is an approval condition.",
            }] : [],
            operations: [],
          });
          fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"),
            `${JSON.stringify(delta.toJSON(), null, 2)}\n`);
        }
        work.seal();
        return { ok: true, status: 0, signal: null, killed: false, stdout: "", stderr: "" };
      }
      reviewProcess = installReviewProcessFake(reviewResponse);
      async function dispatch(maxDispatches = 64, runtime = null) {
        if (interruptTriage) {
          assert.equal(maxDispatches, 64, "interruption acceptance uses the registered production dispatch limit");
          const invoke = runtime?.dispatchFlowCommand ?? dispatchFlowCommand;
          const container = (runtime?.dispatchContainer ?? dispatchContainer)({ root, flowManager, agent });
          const selected = await invoke({
            container, group: "get", name: "next-action",
            argv: ["--expect-run-id", flowManager.loadReadOnly(specId).runId],
          });
          assert.equal(selected.envelope.ok, true, selected.stdout);
          assert.equal(typeof selected.envelope.data.binding, "string", selected.stdout);
          const execution = await invoke({
            container, group: "run", name: "dispatch",
            argv: ["--expect-binding", selected.envelope.data.binding],
          });
          return { ...execution.envelope.data, ok: execution.envelope.ok, errors: execution.envelope.errors };
        }
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches });
        dispatcher.container = dispatchContainer({ root, flowManager, agent });
        return dispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager,
          flowState: flowManager.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: flowManager.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      }
      function assertPublishedSpecHistory(reloaded) {
        const cycles = retainGateFindings ? 4 : 2;
        assert.deepEqual(allRequestSteps(), [
          "spec", "spec-triage", "spec-repair",
          ...Array.from({ length: cycles - 1 }, () => [
            ...Array.from({ length: largeGateResponse ? gateRepairWorkerRuns : 1 }, () => "spec-gate-repair"),
            "spec-triage", "spec-repair",
          ]).flat(),
        ]);
        if (largeGateResponse) {
          assert.equal(gateRepairWorkerRuns, 1, "The complete initial repair input needs one worker call");
          assert.equal(gateRepairInspectionRuns, 0, "File delivery does not add an automatic inspection call");
          assert.equal(gateRepairMutationRuns, 1, "Complete selected finding units share one privileged immutable-file call");
          assert.deepEqual(gateRepairModes, ["repair"]);
          const input = gateRepairRequest.inputs[0];
          const progress = new SpecGateRepairProgressReader({ flowManager: reloaded, specId,
            attemptId: input.descriptor.canonicalLocator.attemptId, consumerNodeId: "spec-gate-repair" });
          const [checkpoint, claimed, repair] = ["checkpoint", "claimed", "publication"]
            .map((phase) => progress.read(0, phase));
          for (const saved of [checkpoint, claimed, repair]) {
            assert.equal(saved.document.generation, 0);
            assert.equal(saved.document.requestDigest, gateRepairIdentity.binding.requestDigest);
            assert.deepEqual(saved.document.context, gateRepairContext);
            assert.deepEqual(saved.document.callCost, repair.document.callCost);
          }
          assert.equal(repair.document.context.mode, "repair");
          assert.equal(repair.document.proposal.stage, "spec-gate-repair");
          assert.equal(checkpoint.budget.snapshot().providerCallCount, 0);
          assert.equal(claimed.budget.snapshot().providerCallCount, 1);
          assert.equal(repair.budget.snapshot().providerCallCount, gateRepairWorkerRuns);
          const frontier = repair.document.plan.budgetFrontier;
          const callCost = repair.document.callCost;
          const responseCost = repair.document.responseCost;
          assert.equal(checkpoint.budget.snapshot().aggregateCharacters,
            frontier.aggregateCharacters + callCost.characters);
          assert.equal(claimed.budget.snapshot().aggregateCharacters, checkpoint.budget.snapshot().aggregateCharacters);
          assert.equal(repair.budget.snapshot().aggregateCharacters,
            frontier.aggregateCharacters + callCost.characters + responseCost.characters);
          assert.equal(repair.budget.snapshot().aggregateItemCount,
            frontier.aggregateItemCount + callCost.items + responseCost.items);
          assert.equal(repairedFindingIdentities.size, 40);
        } else {
          assert.equal(totalRepairs(), cycles - 1);
          assert.equal(gateRepairInspectionRuns, 0);
          assert.equal(gateRepairMutationRuns, gateRepairWorkerRuns);
        }
        assert.equal(totalGates(), cycles);
        assert.equal(totalReviews(), cycles);
        const activities = reloaded.activityLedger(specId);
        assert.equal(activities.find((entry) => entry.nodeId === "spec"
          && entry.result?.stepResult?.kind === "spec-created")
          ?.result.draftSettlementReceipt.targetStepId, "spec-review");
        assert.equal(activities.filter((entry) => entry.nodeId === "spec-gate-repair"
          && entry.result?.stepResult?.kind === "spec-gate-repair-review-required"
          && entry.result.draftSettlementReceipt.targetStepId === "spec-review").length, cycles - 1);
        const reviewPublications = activities.filter((entry) => entry.reviewPublication?.stage === "spec-review");
        assert.equal(reviewPublications.length, cycles);
        assert.notDeepEqual(reviewPublications[0].reviewPublication.identity.revision,
          reviewPublications[1].reviewPublication.identity.revision);
        assert.notEqual(reviewPublications[0].reviewPublication.identity.digest,
          reviewPublications[1].reviewPublication.identity.digest);
        assert.equal(activities.filter((entry) => entry.nodeId === "spec-triage"
          && entry.result?.draftSettlementReceipt?.targetStepId === "spec-repair").length, cycles);
        assert.equal(activities.filter((entry) => entry.nodeId === "spec-repair"
          && entry.result?.draftSettlementReceipt?.targetStepId === "spec-gate").length, cycles);
        if (advisoryRepair) {
          assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
            && entry.result?.stepResult?.kind === "spec-gate-awaiting-decision")
            ?.result.draftSettlementReceipt.settlementKind, "await");
        } else {
          assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
            && entry.result?.stepResult?.kind === "spec-gate-repair-required")
            ?.result.draftSettlementReceipt.targetStepId, "spec-gate-repair");
        }
        if (!retainGateFindings) {
          assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
            && entry.result?.stepResult?.kind === "spec-gate-passed")
            ?.result.draftSettlementReceipt.targetStepId, "approval");
        }
      }
      let result;
      if (interruptTriage) {
        let interrupted;
        if (migrateRuntime) {
          priorRuntime = new PriorSpecWorkerRuntime();
          await priorRuntime.load();
          flowManager = new priorRuntime.FlowManager({ root, mainRoot: root, inWorktree: false, specId });
          const historicalProvider = priorRuntime.installProvider(providerResponse,
            { transportContext: () => ({ root, flowManager }) });
          const historicalReview = priorRuntime.installReview(reviewResponse);
          sealHandoff = priorRuntime.seal;
          agent = workerAgent(priorRuntime.container);
          try { interrupted = await dispatch(64, priorRuntime); }
          finally {
            historicalReview.mock.restore();
            historicalProvider.mock.restore();
            sealHandoff = sealWorkerArtifactHandoff;
          }
        } else interrupted = await dispatch();
        assert.equal(interrupted.ok, false, JSON.stringify(interrupted));
        assert.equal(interruptionDelivered, true, JSON.stringify(interrupted));
        assert.ok(interruptedRequest, "the registered triage provider must create its canonical claim");
        const sourceContract = FlowExecutionContract.fromJSON(interruptedRequest.executionContract);
        assert.equal(sourceContract.runtimeRevision, priorRuntime?.revision ?? currentRuntimePackage().revision);
        const sourceRequestDigest = crypto.createHash("sha256")
          .update(workerArtifactStableStringify(interruptedRequest)).digest("hex");
        const sourceDirectory = path.dirname(interruptedRequestPath);
        assert.equal(fs.existsSync(path.join(sourceDirectory, "handoff.json")), false);
        assert.deepEqual(fs.readFileSync(requestPayloadPath(interruptedRequest, "review.delta.json")), interruptedPayload);
        const inventory = ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root });
        assert.equal(inventory.slot, null);
        assert.ok(inventory.executions.every((execution) => execution.status === "closed"));
        const stoppedExecution = inventory.executions.find((execution) => execution.calls.some((call) =>
          call.binding?.executionContractId === sourceContract.id));
        assert.ok(stoppedExecution, "the unsealed triage must have a real managed physical call");
        const call = stoppedExecution.calls.find((entry) => entry.binding.executionContractId === sourceContract.id);
        assert.equal(call.permit.callId, call.callId);
        assert.equal(call.receipt.stopEvidence.status, "confirmed");
        const runtimeNamespace = fs.readdirSync(path.join(root, ".sennel", "process-runtime"));
        assert.equal(runtimeNamespace.length, 1);
        const archive = JSON.parse(fs.readFileSync(path.join(root, ".sennel", "process-runtime",
          runtimeNamespace[0], "archives", `${stoppedExecution.executionId}.json`), "utf8"));
        assert.deepEqual(archive.payload.execution.calls.find((entry) => entry.callId === call.callId).receipt, call.receipt);
        assert.equal(ProcessExecutionRuntime.current(), null);
        const stops = readFlowProcessStops({ mainRoot: root, executionRoot: root })
          .filter((evidence) => evidence.receipt.binding.value.executionContractId === sourceContract.id);
        assert.equal(stops.length, 1);
        stops[0].assertContract(sourceContract, workerProcessStopIdentity({ ...interruptedRequest,
          executionContract: sourceContract, requestDigest: sourceRequestDigest }));
        assert.equal(stops[0].receipt.callId, call.callId);

        // Discard the dispatcher, coordinator, manager and external Agent before
        // resuming from the canonical claim and closed physical archive.
        flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        agent = workerAgent();
        const stoppedState = flowManager.canonicalState(specId);
        if (migrateRuntime) assert.throws(() => sourceContract.assertCurrent(stoppedState),
          { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
        assert.equal(stoppedState.attempt.id, sourceContract.attemptId);
        assert.equal(stoppedState.attempt.sequence, sourceContract.attemptSequence);
        assert.equal(stoppedState.attempt.failure, null);
        const binding = { runId: stoppedState.runId, specId, stepId: "spec-triage", nodeId: "spec-triage",
          taskId: null, attempt: stoppedState.attempt };
        const retained = flowManager.artifactWorkerExecutionState({ binding });
        assert.equal(retained.executionContract.id, sourceContract.id);
        assert.equal(retained.recovery, null);
        const beforeResume = { state: stoppedState.toJSON(), activities: flowManager.activityLedger(specId),
          catalog: flowManager.artifactCatalog(specId).toJSON() };
        const resumeOutput = [];
        const resumeErrors = [];
        let resumeExit = 0;
        await dispatchRegisteredCommand({
          container: dispatchContainer({ root, flowManager, agent }), entry: flowCommands.resume,
          argv: ["--spec", specId], envelopeType: "run", envelopeKey: "resume", runtimeLog: false,
          buildHookCtx: (container, input) => buildFlowCommandHookContext(container, flowCommands.resume, input),
          stdout: (text) => resumeOutput.push(text), stderr: (text) => resumeErrors.push(text), setExitCode: (code) => { resumeExit = code; },
        });
        const resumed = JSON.parse(resumeOutput.join(""));
        assert.equal(resumeExit, 0, `${JSON.stringify(resumed)}\n${resumeErrors.join("")}`);
        assert.equal(resumed.ok, true, JSON.stringify(resumed));
        assert.equal(resumed.data.runId, sourceContract.runId);
        const selected = await dispatchFlowCommand({
          container: dispatchContainer({ root, flowManager, agent }), group: "get", name: "next-action",
          argv: ["--expect-run-id", sourceContract.runId],
        });
        assert.equal(selected.envelope.ok, true, selected.stdout);
        assert.equal(selected.envelope.data.directive.actionId, "RECOVER_ARTIFACT_EXECUTION");
        assert.equal(selected.envelope.data.directive.command.subcommand, "recover-artifact-execution");
        assert.ok(selected.envelope.data.directive.command.args.includes("--expect-binding"));
        assert.deepEqual({ state: flowManager.canonicalState(specId).toJSON(), activities: flowManager.activityLedger(specId),
          catalog: flowManager.artifactCatalog(specId).toJSON() }, beforeResume);
        assert.equal(requests.filter((request) => request.stepId === "spec-triage").length, 1);
        result = await dispatch();
        const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const frontier = restored.artifactWorkerExecutionState({ binding });
        assert.equal(frontier.contracts.length, 2, JSON.stringify({ errors: result.errors, boundary: result.dispatch?.boundary }));
        assert.equal(frontier.recovery.sourceContractId, sourceContract.id);
        assert.equal(frontier.recovery.targetGeneration, sourceContract.generation + 1);
        assert.equal(frontier.recovery.evidence.budget.providerCallCount, 1);
        assert.equal(frontier.recovery.evidence.migratesRuntime, migrateRuntime);
        assert.equal(frontier.recovery.sourceContract.runtimeRevision, sourceContract.runtimeRevision);
        assert.equal(frontier.recovery.targetContract.runtimeRevision, currentRuntimePackage().revision);
        const replacement = requests.find((request) => request.stepId === "spec-triage" && request !== interruptedRequest);
        assert.equal(frontier.status, "accepted", JSON.stringify({ errors: result.errors, boundary: result.dispatch?.boundary,
          triageGenerations: requests.filter((request) => request.stepId === "spec-triage").map((request) => request.executionContract.generation),
          replacementPhysicalCalls: ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root }).executions
            .flatMap((execution) => execution.calls).filter((call) => call.binding?.executionContractId === frontier.recovery.targetContractId).length }));
        assert.ok(replacement, JSON.stringify(result));
        const targetContract = FlowExecutionContract.fromJSON(replacement.executionContract);
        assert.equal(targetContract.id, frontier.recovery.targetContractId);
        assert.equal(targetContract.runtimeRevision, currentRuntimePackage().revision);
        assert.equal(targetContract.attemptId, sourceContract.attemptId);
        assert.equal(targetContract.attemptSequence, sourceContract.attemptSequence);
        assert.equal(targetContract.episodeId, sourceContract.episodeId);
        assert.equal(targetContract.budgetId, sourceContract.budgetId);
        assert.deepEqual(targetContract.executionLimit, sourceContract.executionLimit);
        assert.notEqual(replacement.dispatchInvocationId, interruptedRequest.dispatchInvocationId);
        const replacementStops = readFlowProcessStops({ mainRoot: root, executionRoot: root })
          .filter((evidence) => evidence.receipt.binding.value.executionContractId === targetContract.id);
        assert.equal(replacementStops.length, 1);
        assert.notEqual(replacementStops[0].receipt.callId, call.callId);
        replacementStops[0].assertContract(targetContract, workerProcessStopIdentity({ ...replacement,
          executionContract: targetContract, requestDigest: crypto.createHash("sha256")
            .update(workerArtifactStableStringify(replacement)).digest("hex") }));
        assert.equal(recoveredTriageConsumed, true, "spec-repair must read and apply the recovered canonical triage");
        assert.equal(restored.readStoredPromptExecutionEpisode({ executionContract: targetContract,
          currentAttempt: false }).budget.providerCallCount, 2);
        assert.deepEqual(fs.readFileSync(requestPayloadPath(interruptedRequest, "review.delta.json")), interruptedPayload);
        const completed = restored.activityLedger(specId).filter((entry) => entry.nodeId === "spec-triage"
          && entry.attemptId === sourceContract.attemptId && entry.result?.stepResult?.kind === "spec-triage-completed");
        assert.equal(completed.length, 1);
        assert.equal(completed[0].result.draftSettlementReceipt.targetStepId, "spec-repair");
      } else if (advisoryRepair) {
        let observedAwaitAfterReload = false;
        for (let index = 0; index < 32; index += 1) {
          const repaired = flowManager.activityLedger(specId).some((entry) => (
            entry.transition?.operation === "plan_gate_repair"
            && entry.transition?.nonblocking?.action === "repair"
          ));
          if (repaired) break;
          if (flowManager.canonicalState(specId).current?.at(-1) === "spec-gate") {
            const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
            const saved = restored.readCurrentStepSettlement({ specId, stepId: "spec-gate" });
            if (saved?.result.kind === "spec-gate-awaiting-decision") {
              assert.equal(saved.receipt.settlementKind, "await");
              assert.ok(readCurrentGateTransitionFacts({
                flowManager: restored, flowState: restored.loadReadOnly(specId), phase: "spec", root,
              }));
              const next = await new GetNextActionCommand().execute({
                root, mainRoot: root, executionRoot: root, specId,
                flowManager: restored, flowState: restored.loadReadOnly(specId),
              });
              assertSelectedGateInstructions(next);
              assert.ok(next.nonblockingDecision.allowedActions.includes("repair"));
              observedAwaitAfterReload = true;
            }
          }
          const partial = await dispatch(1);
          assert.equal(partial.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(partial));
        }
        assert.equal(observedAwaitAfterReload, true);
        const reloadedRepair = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.equal(reloadedRepair.canonicalState(specId).current.at(-1), "spec-gate-repair");
        assert.equal(reloadedRepair.activityLedger(specId).filter((entry) => (
          entry.transition?.operation === "plan_gate_repair"
          && entry.transition?.nonblocking?.action === "repair"
        )).length, 1);
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: reloadedRepair, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: reloadedRepair,
          flowState: reloadedRepair.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: reloadedRepair.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      } else if (largeGateResponse) {
        let savedGate = null;
        for (let index = 0; index < 16; index += 1) {
          savedGate = flowManager.activityLedger(specId).find((entry) => entry.nodeId === "spec-gate"
            && entry.result?.stepResult?.kind === "spec-gate-repair-required");
          if (savedGate) break;
          const partial = await dispatch(1);
          assert.equal(partial.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(partial));
        }
        assert.equal(savedGate?.result.stepResult.kind, "spec-gate-repair-required");
        const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const savedHistory = JSON.parse(restored.readArtifact({
          specId, logicalKey: "spec.gate", consumerNodeId: "spec-gate-repair",
        }).bytes.toString("utf8"));
        const savedFindings = savedHistory.attempts[0].artifact.payload.artifacts.nextAction.diagnosis.observations;
        assert.equal(savedFindings.length, 40);
        assert.equal(new Set(savedFindings.map((finding) => JSON.stringify(finding.targets))).size, 8);
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: restored, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: restored,
          flowState: restored.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: restored.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      } else if (!seed) {
        result = await dispatch();
      }
      if (retainGateFindings) {
        const stopped = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const strict = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId,
          flowManager: stopped, flowState: stopped.loadReadOnly(specId),
        });
        assertSelectedGateInstructions(strict);
        assert.equal(strict.directive.kind, "blocked", JSON.stringify({ result, strict }));
        assert.equal(strict.directive.requiresUserAction, false);
        assert.match(strict.directive.reason, /cycle 4 reached maximum 4/);
        assert.match(strict.directive.resumeInstruction, /sennel flow set policy nonblocking/);
        const before = stopped.readCurrentStepSettlement({ specId, stepId: "spec-gate" });
        assert.equal(before.result.kind, "spec-gate-blocked");
        assert.equal(before.result.error.data.reason, "cycle-limit");
        assert.deepEqual(readCurrentGateTransitionFacts({ flowManager: stopped,
          flowState: stopped.loadReadOnly(specId), phase: "spec", root }).specCycle.toJSON(),
        { cycle: 4, completedRepairs: 3 });
        const strictState = stopped.canonicalState(specId).toJSON();
        const strictActivities = stopped.activityLedger(specId);
        const strictCatalog = stopped.artifactCatalog(specId).toJSON();
        const strictDispatcher = new RunDispatchCommand({ agent, maxDispatches: 64 });
        strictDispatcher.container = dispatchContainer({ root, flowManager: stopped, agent });
        const strictBoundary = await strictDispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: stopped,
          flowState: stopped.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: stopped.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
        assert.equal(strictBoundary.dispatch?.boundary, "blocked");
        assert.deepEqual(stopped.canonicalState(specId).toJSON(), strictState);
        assert.deepEqual(stopped.activityLedger(specId), strictActivities);
        assert.deepEqual(stopped.artifactCatalog(specId).toJSON(), strictCatalog);
        assertPublishedSpecHistory(stopped);
        if (strictSeed) {
          const history = SpecPhaseHistory.read(stopped, specId);
          assert.deepEqual(history.requestSteps, allRequestSteps());
          assert.deepEqual(history.requestDigests, requests.map((request) => crypto.createHash("sha256")
            .update(workerArtifactStableStringify(request)).digest("hex")));
          assert.equal(history.specWorkers, specWorkerRuns);
          assert.equal(history.reviews, specReviewRuns);
          assert.equal(history.gates, specGateAttempts.size);
          assert.equal(history.repairs, gateRepairWorkerRuns);
          assert.deepEqual(sealFailures, []);
          retainRoot = true;
          return { root, specId };
        }
        if (reopenPlanning) {
          assert.equal(totalRepairs(), 3);
          const oldAudits = stopped.artifactCatalog(specId).artifacts.filter((entry) => entry.logicalKey === "spec.gate.repair.audit");
          assert.equal(oldAudits.length, 3);
          const reopened = await new RunReopenDraftCommand().execute({
            root, flowManager: stopped, flowState: stopped.loadReadOnly(specId),
            reason: "Regenerate the plan with explicit verification after the exhausted planning cycle.",
          });
          assert.equal(reopened.ok, true, JSON.stringify(reopened));
          flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
          const reopenActivity = flowManager.activityLedger(specId).at(-1);
          assert.equal(reopenActivity.transition.operation, "reopen_draft_preimplementation");
          assert.deepEqual(flowManager.activityLedger(specId).slice(0, strictActivities.length), strictActivities);
          // Run the normal Draft and Spec producers, then discard their in-memory manager.
          for (let index = 0; index < 24 && flowManager.canonicalState(specId).nextAction().nodeId !== "spec-gate"; index += 1) {
            const partial = await dispatch(1);
            assert.equal(partial.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(partial));
          }
          assert.equal(draftWorkerRuns, 1);
          assert.equal(totalSpecWorkers(), 2);
          flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
          assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "spec-gate");
          const regeneratedDraft = flowManager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" });
          assert.equal(JSON.parse(regeneratedDraft.bytes).goal, "Reconsider the plan with explicit verification.");
          const regeneratedSpec = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate" });
          assert.match(JSON.parse(regeneratedSpec.bytes).requirements.find((entry) => entry.id === "R10").desc, /regenerated plan/);
          const specPublication = flowManager.activityLedger(specId).find((entry) => entry.id === regeneratedSpec.descriptor.activityId);
          assert.ok(specPublication.confirmationOrder > reopenActivity.confirmationOrder);
          let newGate = null;
          let firstGate;
          for (let index = 0; index < 8 && newGate === null; index += 1) {
            firstGate = await dispatch(1);
            flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
            newGate = flowManager.activityLedger(specId).find((entry) => entry.nodeId === "spec-gate"
              && entry.result?.stepResult && entry.confirmationOrder > specPublication.confirmationOrder
              && entry.confirmationOrder > reopenActivity.confirmationOrder) ?? null;
            if (newGate === null) assert.equal(firstGate.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(firstGate));
          }
          assert.ok(newGate, "a new Gate must actually evaluate the regenerated Spec before checking repair eligibility");
          const gateHistory = JSON.parse(flowManager.readArtifact({ specId, logicalKey: "spec.gate",
            consumerNodeId: "spec-gate-repair" }).bytes);
          const evaluated = gateHistory.attempts.at(-1).artifact.payload;
          assert.equal(evaluated.artifacts.gateTransitionAttemptId, newGate.attemptId);
          assert.equal(evaluated.artifacts.gateTransitionAttemptSequence, newGate.sequence);
          const findings = evaluated.artifacts.nextAction.diagnosis.observations;
          assert.ok(findings.length > 0);
          assert.ok(findings.every((finding) => finding.specRevision === `sha256:${regeneratedSpec.descriptor.hash}`));
          assert.equal(newGate.result.stepResult.kind, "spec-gate-repair-required",
            `the first Gate of a regenerated planning cycle must admit its first repair: ${JSON.stringify(newGate.result.stepResult)}`);
          assert.equal(firstGate.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(firstGate));
          assert.equal(gateFacts.readSpecGateCycleProgress({ flowManager, state: flowManager.canonicalState(specId) }).cycle, 1);
          assert.equal(flowManager.canonicalState(specId).current.at(-1), "spec-gate-repair");
          const newRepair = await dispatch(1);
          assert.equal(newRepair.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(newRepair));
          flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
          const currentAudits = flowManager.artifactCatalog(specId).artifacts.filter((entry) => entry.logicalKey === "spec.gate.repair.audit");
          assert.equal(currentAudits.length, 4);
          for (const previous of oldAudits) assert.deepEqual(currentAudits.find((entry) => entry.relativePath === previous.relativePath), previous);
          const repairedSpec = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate" });
          assert.match(JSON.parse(repairedSpec.bytes).requirements.find((entry) => entry.id === "R10").desc, /regenerated plan.*observation is addressed/);
          const newStop = await dispatch();
          flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
          const settled = flowManager.readCurrentStepSettlement({ specId, stepId: "spec-gate" });
          assert.equal(settled.result.kind, "spec-gate-blocked", JSON.stringify(newStop));
          assert.deepEqual(settled.result.error.data, { reason: "cycle-limit", cycle: 4, maximum: 4 });
          assert.deepEqual(readCurrentGateTransitionFacts({ flowManager,
            flowState: flowManager.loadReadOnly(specId), phase: "spec", root }).specCycle.toJSON(),
          { cycle: 4, completedRepairs: 3 });
          assert.equal(totalRepairs(), 6);
          assert.equal(gateRepairWorkerRuns, seed ? 3 : 6);
          assert.equal(specGateAttempts.size, seed ? 4 : 8);
          assert.equal(specWorkerRuns, seed ? 1 : 2);
          assert.equal(flowManager.activityLedger(specId).filter((entry) => entry.transition.operation.startsWith("reopen_draft_")).length, 1);
          assert.deepEqual(flowManager.activityLedger(specId).slice(0, strictActivities.length), strictActivities);
          assert.deepEqual(sealFailures, []);
          return;
        }
        activateNonBlockingPolicy({ root, flowManager: stopped, reason: "Retain the unresolved Spec observation for Acceptance." });
        const decision = decisionContextForActiveFlow(root, stopped.loadReadOnly(specId), stopped);
        assert.equal(decision.resultKind, "quality");
        assert.deepEqual(decision.allowedActions, ["continue"]);
        const advisoryState = stopped.canonicalState(specId).toJSON();
        const advisoryActivities = stopped.activityLedger(specId);
        const advisoryCatalog = stopped.artifactCatalog(specId).toJSON();
        assert.throws(() => recordNonBlockingDecision({
          root, flowManager: stopped, choice: "repair",
          reason: "An exhausted Spec repair must be rejected.",
          expectEvidenceDigest: decision.evidenceDigest,
        }), /not allowed/);
        assert.deepEqual(stopped.canonicalState(specId).toJSON(), advisoryState);
        assert.deepEqual(stopped.activityLedger(specId), advisoryActivities);
        assert.deepEqual(stopped.artifactCatalog(specId).toJSON(), advisoryCatalog);
        recordNonBlockingDecision({
          root, flowManager: stopped, choice: "continue",
          reason: "The Spec can proceed with explicit deferred review.",
          remainingRisk: "Acceptance must decide the unresolved Spec Gate observation.",
          expectEvidenceDigest: decision.evidenceDigest,
        });
        const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: resumed, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: resumed,
          flowState: resumed.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: resumed.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      }
      assert.equal(result.dispatch?.boundary, "approval_required", JSON.stringify({
        boundary: result.dispatch?.boundary,
        errors: result.errors,
        requests: requests.map((request) => request.stepId),
        next: flowManager.canonicalState(specId).nextAction().nodeId,
        specGateRuns: specGateAttempts.size,
        specReviewRuns, specWorkerRuns, sealFailures,
      }, null, 2));
      const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      assertPublishedSpecHistory(reloaded);
      const cycles = retainGateFindings ? 4 : 2;
      const specGateHistory = JSON.parse(reloaded.readArtifact({
        specId, logicalKey: "spec.gate", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.deepEqual(specGateHistory.attempts.map((entry) => [
        entry.artifact.payload.result, entry.artifact.payload.artifacts.failureKind ?? null,
      ]), retainGateFindings
        ? Array.from({ length: cycles }, () => ["fail", "ai_semantic_fail"])
        : [["fail", "ai_semantic_fail"], ["pass", null]]);
      if (largeSpecFile) {
        assert.equal(firstGroupReadFailures, 3);
        const evidence = specGateHistory.attempts[0].artifact.payload.artifacts.responseProtocolEvidence;
        const recovered = evidence.groups.find((group) => group.attempts.length === 4);
        assert.ok(recovered, JSON.stringify(evidence));
        assert.deepEqual(recovered.attempts.map((attempt) => attempt.failureKind),
          ["file-read-failed", "file-read-failed", "file-read-failed", null]);
        assert.equal(recovered.providerAttemptCount, 4);
        assert.equal(recovered.responseCallCount, 4);
        assert.equal(recovered.outcome, "accepted");
      }
      if (largeGateResponse) {
        assert.ok(largeFirstResponse.length > 120_000);
        assert.equal(specGateHistory.attempts[0].artifact.payload.artifacts.nextAction.diagnosis.observations.length, 40);
      }
      assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "approval");
      const projected = await new GetNextActionCommand().execute({
        root, mainRoot: root, executionRoot: root, specId,
        flowManager: reloaded, flowState: reloaded.loadReadOnly(specId),
      });
      assert.equal(projected.step, "approval");
      const spec = JSON.parse(reloaded.readArtifact({
        specId, logicalKey: "spec.record", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.equal(spec.goal, approvedGoal);
      if (largeRepairValues) {
        await assertSummaryPreservesPublishedEvidence({ root, specId, flowManager: reloaded,
          binding: projected.binding, requirement: reviewedRequirement });
      }
      if (overlongAcceptance) {
        const retainedText = spec.tasks.find((task) => task.id === "T1").acceptance[0];
        assert.equal(retainedText, overlongAcceptanceText.slice(0, 500));
        assert.equal(retainedText.length, 500);
        assert.equal(typeof acceptanceTruncationLogPath, "string");
        const [truncation] = fs.readFileSync(acceptanceTruncationLogPath, "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(truncation.event, "spec-task-acceptance-truncated");
        assert.equal(truncation.taskId, "T1");
        assert.equal(truncation.acceptanceIndex, 0);
        assert.equal(typeof truncation.attemptId, "string");
        assert.equal(typeof truncation.attemptSequence, "number");
        assert.equal(truncation.originalText, overlongAcceptanceText);
        assert.equal(truncation.retainedText, retainedText);
        assert.equal(truncation.originalLength, 501);
        assert.equal(truncation.retainedLength, 500);
      }
      assert.equal(spec.requirements[0].desc, reviewedRequirement);
      assert.match(spec.requirements.find((entry) => entry.id === "R10").desc,
        /Spec Gate observation is addressed/);
      if (largeRepairValues) assert.equal(spec.requirements.find((entry) => entry.id === "R10").desc, gateRepairValue);
      if (largeGateResponse) {
        for (const id of largeFindingIds) {
          assert.match(spec.requirements.find((entry) => entry.id === id).desc,
            /Spec Gate observation is addressed/);
        }
      }
      const testSpec = new CanonicalTestArtifactStore({
        flowManager: reloaded, state: reloaded.loadReadOnly(specId),
      }).readSpec("test-generate");
      assert.equal(testSpec.requirements[0].desc, reviewedRequirement);
      assert.deepEqual(testSpec.requirements, spec.requirements);
      const acceptance = await new CanonicalAcceptanceArtifactStore({
        state: reloaded.loadReadOnly(specId), flowManager: reloaded,
      }).buildContext({ executionRoot: root });
      assert.deepEqual(acceptance.requirementIds, ["R1", ...(largeGateResponse ? largeFindingIds : ["R10"])]);
      assert.equal(acceptance.evidence.requirements[0].desc, reviewedRequirement);
      assert.deepEqual(acceptance.evidence.requirements, spec.requirements);
      assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "invalid_spec"), false);
      if (retainGateFindings) {
        assert.equal(acceptance.deferredFindings.length, 1);
        assert.equal(acceptance.deferredFindings[0].sourceStep, "spec-gate");
        assert.equal(acceptance.deferredFindings[0].finalDisposition, "still_open");
        assert.equal(acceptance.evidence.deferredFindingEvidence.length, 1);
        assert.equal(acceptance.evidence.deferredFindingEvidence[0].sourceFinding.observed,
          "Spec behavior 4 needs a separate clarification.");
        assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "missing_deferred_source"), false);
      }
      // Later Test/Implementation evidence has deliberately not been produced;
      // only Acceptance's use of Spec artifacts belongs to this scenario.
      assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "missing_artifact"), true);
      const approval = new SetApprovalCommand().execute({
        root, mainRoot: root, executionRoot: root, specId, flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId), approved: true,
        confirmedAt: "2026-09-23T00:00:00.000Z", notes: "The repaired requirement was reviewed.",
      });
      assert.deepEqual(approval.added, ["T1"]);
      const approved = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const saved = JSON.parse(approved.readArtifact({
        specId, logicalKey: "spec.record", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.deepEqual(approved.loadReadOnly(specId).tasks.map(({ id, goal }) => ({ id, goal })),
        saved.tasks.map(({ id, goal }) => ({ id, goal })));
      assert.equal(saved.requirements[0].desc, reviewedRequirement);
      assert.equal(saved.user_approval.confirmed_at, "2026-09-23T00:00:00.000Z");
      assert.notEqual(approved.canonicalState(specId).nextAction().nodeId, "approval");
      const approvedReview = approved.readCurrentSpecReview({ specId, consumerNodeId: "approval" });
      assert.ok(approvedReview, "actual confirmation must retain its exact reviewed Spec basis after approval metadata advances the root");
      const plan = JSON.parse(approved.readArtifact({ specId, logicalKey: "test.requirement.plan",
        consumerNodeId: "test-generate" }).bytes.toString("utf8")).plan;
      assert.deepEqual(approvedReview.review.identity.toJSON(), plan.specRevision);
      const approvedSnapshot = approved.readArtifact({ specId, logicalKey: "spec.snapshot",
        parameters: { revision: approvedReview.review.identity.revision.toString() }, consumerNodeId: "approval" });
      assert.equal(approvedSnapshot.descriptor.hash, plan.specRevision.digest);
      assert.equal(approvedSnapshot.bytes.length, plan.specRevision.byteLength);
    } finally {
      reviewProcess?.mock.restore();
      gateAgentLookup?.mock.restore();
      priorRuntime?.remove();
      if (!retainRoot) removeTmpDir(root);
    }
  }
}
