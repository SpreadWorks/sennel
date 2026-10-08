import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ImplPhaseScenario } from "./impl-phase-scenario.js";
import { SeedWorkRoot } from "./builders/seed-work-root.js";
import { futurePhaseManifests } from "./structure/phase-manifest.js";
import { dispatch } from "../../src/lib/dispatcher.js";
import { buildFlowCommandHookContext } from "../../src/flow/lib/flow-context.js";
import { dispatchContainer } from "./infrastructure/flow-dispatch-scenario.js";
import { FLOW_COMMANDS } from "../../src/flow/registry.js";
import { StepResult } from "../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt } from "../../src/flow/definition.js";
import { CanonicalAcceptanceArtifactStore } from "../../src/flow/lib/canonical-acceptance-artifacts.js";
import { AcceptanceRepairFindingSet } from "../../src/flow/lib/acceptance-review-artifacts.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../src/flow/lib/canonical-command-result.js";
import { assertAcceptancePhaseResult, assertAcceptancePhaseSettlementRoundtrip } from "./assertions/acceptance-phase-result.js";

const acceptanceLeaves = futurePhaseManifests.find((manifest) => manifest.id === "04").leaves;

export function acceptanceProviderResponse(scenario, { status = "met", disposition = "fixed" } = {}) {
  const evidence = scenario.acceptanceContexts.at(-1);
  assert.ok(evidence, "external Acceptance response needs the actual consumer's canonical input");
  return {
    requirementJudgments: evidence.requirementIds.map((requirementId) => ({ requirementId, status,
      requestRefs: ["flow.request"], requirementRefs: [`spec.json#${requirementId}`],
      diffRefs: [], repairRefs: [evidence.evidence.repairEvidence.ref], testRefs: [],
      missingEvidence: status === "notVerifiable" ? ["Independent semantic confirmation is required."] : [],
    })),
    deferredFindingDispositions: evidence.deferredFindings
      .filter((entry) => ["still_open", "blocking"].includes(entry.finalDisposition))
      .map((entry) => ({ findingId: entry.findingId, finalDisposition: disposition,
        evidenceRefs: [`${entry.sourceArtifact}#${entry.sourceFindingId}`] })),
  };
}

/** Phase 04 extends the existing real phase 02/03 producer. Only external
 * worker/provider/process responses are controlled. The inherited dispatcher,
 * registry, parsing, Stores, settlement and all consumers remain production. */
export class AcceptancePhaseScenario extends ImplPhaseScenario {
  static publicationObserverOptions = { leaves: acceptanceLeaves };
  static create(t, options = {}) {
    const gateResponse = options.gateResponse;
    return super.create(t, {
      entryStep: "draft",
      execution: { mode: "branch", baseBranch: "main", featureBranch: "feature/acceptance-phase" },
      ...options,
      gateResponse: (prompt, invocation, active) => {
        if (active.current() === "acceptance-review" && options.acceptanceProvider) {
          const call = { prompt, options: invocation, response: null };
          active.acceptanceCalls.push(call);
          const selected = options.acceptanceProvider?.(prompt, invocation, active);
          call.response = selected;
          if (selected !== undefined && selected !== null) return selected;
        }
        if ((invocation.jsonSchema?.required ?? []).includes("requirementJudgments")) {
          const evidence = JSON.parse(String(prompt).slice("## Acceptance Evidence\n".length));
          active.acceptanceContexts.push(Object.freeze({ evidence,
            requirementIds: evidence.requirements.map((entry) => entry.id),
            deferredFindings: evidence.deferredFindings }));
          const response = options.acceptanceResponse?.(active.acceptanceCalls.length + 1, active, prompt, invocation)
            ?? acceptanceProviderResponse(active);
          active.acceptanceCalls.push({ prompt, options: invocation, response: structuredClone(response) });
          return JSON.stringify(response);
        }
        return gateResponse?.(prompt, invocation, active);
      },
    });
  }

  constructor(options) {
    super(options);
    this.acceptanceCalls = [];
    this.acceptanceContexts = [];
    this.registeredExecutions = [];
  }

  initialize() {
    if (!this.options.prepared && !this.seedClone && this.options.execution.mode === "branch") {
      const result = spawnSync("git", ["switch", "-c", this.options.execution.featureBranch], { cwd: this.root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    super.initialize();
  }

  /** Freeze a genuine completed upstream producer frontier; copies are never
   * repaired, rebased or patched. Every consumer gets a different owned root. */
  static async seed(t, { frontier = "retro", ...options } = {}) {
    const producer = this.create(t, options);
    await producer.advanceTo(frontier);
    producer.reload();
    const copy = new SeedWorkRoot(producer.root, { prefix: "sennel-acceptance-seed-" });
    t.after(() => copy.cleanup());
    return Object.freeze({ root: copy.root, specId: producer.specId, frontier,
      snapshot: producer.snapshot(), options: Object.freeze({ ...options }) });
  }

  static fromSeed(t, seed, options = {}) {
    const scenario = this.create(t, { ...seed.options, ...options, seedRoot: seed.root, seedSpecId: seed.specId });
    assert.deepEqual(scenario.snapshot(), seed.snapshot, "a copied producer frontier cannot fabricate or rewrite canonical evidence");
    assert.equal(scenario.current(), seed.frontier);
    assert.notEqual(scenario.root, seed.root);
    return scenario;
  }

  async observeAcceptanceInput() {
    const input = await new CanonicalAcceptanceArtifactStore({ flowManager: this.manager,
      state: this.manager.loadReadOnly(this.specId) }).buildContext({ executionRoot: this.root });
    this.acceptanceContexts.push(input);
    return input;
  }

  /** Actual command registration route for direct/preview boundary contracts. */
  async runRegistered(name, extra = {}) {
    return this.invokeRegistered("run", name, extra);
  }

  async invokeRegistered(group, name, extra = {}, positional = []) {
    const registration = FLOW_COMMANDS[group][name];
    assert.ok(registration, `production run command ${name} must exist`);
    const invocationContainer = dispatchContainer({ root: this.root, flowManager: this.manager, agent: this.agent });
    const argv = [...positional, ...Object.entries(extra).flatMap(([key, value]) => {
      const option = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return value === true ? [option] : value === false || value == null ? [] : [option, String(value)];
    })];
    const execution = { name, argv, result: null, exitCode: 0, stdout: "", stderr: "" };
    this.registeredExecutions.push(execution);
    await dispatch({ container: invocationContainer, entry: registration, argv,
      envelopeType: group, envelopeKey: name,
      buildHookCtx: (container, input) => buildFlowCommandHookContext(container, registration, input),
      stdout: (text) => { execution.stdout += text; }, stderr: (text) => { execution.stderr += text; },
      setExitCode: (code) => { execution.exitCode = code; } });
    const envelope = JSON.parse(execution.stdout);
    execution.result = envelope.ok === false ? envelope : envelope.data;
    return execution.result;
  }

  async acceptDecision(choice, extra = {}) {
    return this.invokeRegistered("set", "acceptance-decision", { choice, ...extra });
  }

  async worker(prompt, options) {
    const request = JSON.parse(fs.readFileSync(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST, "utf8"));
    if (request.stepId === "impl-triage" && request.inputs.some((entry) => entry.name === "acceptance-review.json")) {
      this.requests.push(request); this.phaseWorkers.push(request);
      const acceptance = request.inputs.find((entry) => entry.name === "acceptance-review.json").document;
      return JSON.stringify({ version: 1, stepId: request.stepId, completionStatus: "done", issues: [],
        overview: null, triage: { version: 1, dispositions: new AcceptanceRepairFindingSet(acceptance).keys
          .map((findingKey) => ({ findingKey, disposition: "apply", basis: "repair-required",
            rationale: "Repair this exact canonical Acceptance finding." })) }, repair: null, noChangeReason: null });
    }
    if (request.stepId === "impl-repair") {
      const triage = request.inputs.find((entry) => entry.name === "impl-triage.json")?.document;
      if (triage?.dispositions.some((entry) => entry.findingKey.startsWith("requirement:") || entry.findingKey.startsWith("hard-blocker:"))) {
        this.requests.push(request); this.phaseWorkers.push(request);
        const source = "src/implementation.js";
        fs.appendFileSync(path.join(this.root, source), "// repaired the canonical Acceptance finding\n");
        return JSON.stringify({ version: 1, stepId: request.stepId, completionStatus: "done", issues: [],
          overview: null, triage: null, repair: { version: 1, findings: triage.dispositions
            .filter((entry) => entry.disposition === "apply").map((entry) => ({ findingKey: entry.findingKey, paths: [source] })),
            summary: "Corrected the exact Acceptance finding.", recurrenceResolutions: [] }, noChangeReason: null });
      }
    }
    return super.worker(prompt, options);
  }

  commandArtifact(logicalKey, consumerNodeId = this.current()) {
    if (!["acceptance.review", "acceptance.decision"].includes(logicalKey)) return super.commandArtifact(logicalKey, consumerNodeId);
    return new CanonicalAcceptanceArtifactStore({ flowManager: this.manager,
      state: this.manager.loadReadOnly(this.specId), nodeId: consumerNodeId }).readCurrentAttempt(logicalKey);
  }

  assertResults(nodeIds, { terminal = true } = {}) {
    const state = this.state();
    const activities = this.manager.activityLedger(this.specId);
    for (const id of nodeIds) {
      const candidates = activities.filter((entry) => entry.nodeId === id && entry.result?.stepResult
        && (terminal ? entry.result.draftSettlementReceipt?.settlementKind !== "execution"
          : entry.result.draftSettlementReceipt?.settlementKind === "execution"));
      assert.ok(candidates.length,
        `ACCEPTANCE_PHASE_RESULT_MISSING: ${id} must persist its concrete Result, canonical publication and exact settlement receipt`);
      const activity = candidates.at(-1);
      const result = StepResult.fromStored(id, activity.result.stepResult.toJSON?.() ?? activity.result.stepResult);
      assertAcceptancePhaseResult(result);
      const settlement = assertAcceptancePhaseSettlementRoundtrip(result);
      const receipt = activity.result.draftSettlementReceipt;
      DraftStepSettlementReceipt.assertStored(receipt, { result, settlement, binding: {
        runId: state.runId, specId: state.specId, stepId: id,
        attempt: { id: activity.attemptId, sequence: activity.sequence },
      } });
      const saved = this.publicationObserver.authenticate(this.manager, activity, result, settlement);
      assert.deepEqual(saved.receipt.toJSON?.() ?? saved.receipt, receipt.toJSON?.() ?? receipt);
      assert.deepEqual(saved.activity.result.stepResult.toJSON(), result.toJSON());
      if (settlement.kind === "target-connection") {
        assert.equal(saved.afterState.current?.at(-1) ?? saved.afterState.nextAction()?.nodeId, receipt.targetStepId);
      } else {
        assert.equal(receipt.connector, null);
        assert.equal(receipt.targetStepId, null);
      }
    }
  }

  artifactHistory(logicalKey, consumerNodeId = this.current()) {
    const artifact = this.manager.readArtifact({ specId: this.specId, logicalKey, consumerNodeId });
    return CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: artifact.bytes });
  }
}
