/** Canonical publication history for bounded Gate repair worker batches. */
import { readSpecGateRepairInput } from "./spec-gate-repair-input.js";
import { FlowFindingSourceIdentity } from "./flow-findings.js";
import { SpecGateRepairContextExpansion } from "./spec-gate-repair-evidence.js";
import { PromptRequestLimit, PromptExecutionLimit, PromptExecutionBudget } from "../../lib/prompt-batching.js";

const REPAIR_BUDGET_LIMIT = Object.freeze({ maxBatchCount: 16, maxProviderCallCount: 16,
  maxSynthesisCallCount: 16, maxAggregateCharacters: 1_000_000, maxAggregateItemCount: 100_000 });

export function latestRepairBudget({ flowManager, specId, attemptId, baseRevision, consumerNodeId }) {
  const prefix = `artifacts/spec-gate-repairs/${attemptId}/progress/`;
  const phaseOrder = { checkpoint: 0, claimed: 1, publication: 2 };
  const descriptor = flowManager.artifactCatalog(specId).artifacts
    .filter((entry) => entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.startsWith(prefix))
    .sort((a, b) => {
      const left = a.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/);
      const right = b.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/);
      if (left === null || right === null) throw new Error("Gate repair budget has an invalid progress artifact");
      return Number(left[1]) - Number(right[1]) || phaseOrder[left[2]] - phaseOrder[right[2]];
    }).at(-1);
  if (descriptor === undefined) return {
    limit: new PromptExecutionLimit(REPAIR_BUDGET_LIMIT),
    budget: new PromptExecutionBudget(new PromptExecutionLimit(REPAIR_BUDGET_LIMIT)),
  };
  const [, generation, phase] = descriptor.relativePath.slice(prefix.length).match(/^(\d+)-(checkpoint|claimed|publication)\.json$/) ?? [];
  if (generation === undefined) throw new Error("Gate repair budget has an invalid claimed generation");
  const saved = JSON.parse(flowManager.readArtifact({ specId: specId,
    logicalKey: "spec.gate.repair.progress", consumerNodeId: consumerNodeId,
    parameters: { attemptId: attemptId, generation, phase },
  }).bytes.toString("utf8"));
  if (saved.version !== 1 || saved.phase !== phase
    || saved.context?.baseRevision !== baseRevision
    || saved.attemptId !== attemptId) throw new Error("Gate repair budget checkpoint differs from the active Attempt");
  const limit = new PromptExecutionLimit(saved.limit);
  return { limit, budget: PromptExecutionBudget.fromSnapshot(limit, saved.budget) };
}

export const SPEC_GATE_REPAIR_REQUEST_LIMIT = new PromptRequestLimit({ maxCharacters: 100_000 });

export function readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot, executionLifecycle = null }) {
  let source = readSpecGateRepairInput({ flowManager, state, executionRoot });
  const ledger = new SpecGateRepairProgressLedger({ flowManager, specId: state.specId,
    attemptId: state.attempt.id, baseRevision: source.baseRevision, executionLifecycle });
  const locationPlan = source.context.unresolvedFindings().length > 0
    ? source.context.locationPlan({ limit: SPEC_GATE_REPAIR_REQUEST_LIMIT }) : null;
  if (locationPlan !== null && ledger.forMode("locate").length === locationPlan.batches.length) {
    const unresolved = new Set(source.context.unresolvedFindings().map((finding) => finding.identity.toString()));
    const resolved = source.context.resolveLocationBatches({ plan: locationPlan,
      responses: ledger.forMode("locate").map((entry) => ({
        batchDigest: entry.context.batchDigest, baseRevision: entry.context.baseRevision,
        locations: entry.proposal.locations,
      })) });
    if (resolved.unresolvedFindings().length === 0) {
      source = readSpecGateRepairInput({ flowManager, state, executionRoot,
        locations: resolved.units().flatMap((unit) => unit.findings
          .filter((finding) => unresolved.has(finding.identity.toString()))
          .map((finding) => ({ identity: finding.identity.toJSON(), rangeIds: finding.rangeIds }))) });
    }
  }
  return Object.freeze({ source, ledger, locationPlan });
}

export class SpecGateRepairProgressLedger {
  constructor({ flowManager, specId, attemptId, baseRevision, executionLifecycle = null }) {
    if (typeof attemptId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseRevision)) {
      throw new TypeError("Gate repair progress requires its Attempt and revision");
    }
    const prefix = `artifacts/spec-gate-repairs/${attemptId}/progress/`;
    const descriptors = flowManager.artifactCatalog(specId).artifacts.filter((entry) => (
      entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.startsWith(prefix)
      && entry.relativePath.endsWith("-publication.json")
    ));
    const entries = descriptors.map((entry) => {
      const match = entry.relativePath.slice(prefix.length).match(/^(\d+)-publication\.json$/);
      if (match === null) throw new Error("Gate repair publication has an invalid generation path");
      const document = JSON.parse(flowManager.readArtifact({ specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId, generation: match[1], phase: "publication" },
      }).bytes.toString("utf8"));
      if (document.version !== 1 || document.phase !== "publication"
        || document.attemptId !== attemptId
        || document.generation !== Number(match[1]) || document.context?.baseRevision !== baseRevision) {
        throw new Error("Gate repair publication differs from its canonical Attempt and revision");
      }
      return Object.freeze(document);
    }).sort((a, b) => a.generation - b.generation);
    const batchKeys = entries.map((entry) => JSON.stringify([
      entry.context.mode, entry.context.unitId ?? null,
      entry.context.evidenceContextDigest ?? null, entry.context.evidenceDepth ?? null,
      entry.context.batchDigest,
    ]));
    if (new Set(batchKeys).size !== batchKeys.length) throw new Error("Gate repair published a batch twice");
    // A response is validated against the input frontier of its exact claimed
    // generation. Its own publication advances future requests, not its replay.
    this.publication = null;
    if (executionLifecycle?.phase === "publication") {
      const saved = entries.at(-1);
      if (saved?.generation !== executionLifecycle.executionGeneration
        || saved.requestDigest !== executionLifecycle.claim.requestDigest
        || saved.inputRevision !== executionLifecycle.binding.inputRevision) {
        throw new Error("Gate repair publication differs from its current execution claim");
      }
      this.publication = saved;
    }
    this.entries = Object.freeze(this.publication === null ? entries : entries.slice(0, -1));
    Object.freeze(this);
  }

  forMode(mode) { return this.entries.filter((entry) => entry.context.mode === mode); }

  groups() { return this.forMode("repair")
    .filter((entry) => entry.proposal.stage === "spec-gate-repair")
    .flatMap((entry) => entry.proposal.groups); }

  additionalRangeIds(context, unitId, { beforeGeneration = Infinity } = {}) {
    let ids = [];
    for (const entry of this.entries) {
      if (entry.generation >= beforeGeneration
        || entry.proposal.stage !== "spec-gate-repair-context-request"
        || entry.proposal.unitId !== unitId) continue;
      ids = new SpecGateRepairContextExpansion({ context, unitId,
        baseRevision: entry.proposal.baseRevision,
        requestedRangeIds: entry.proposal.additionalRangeIds,
        previousRangeIds: ids }).additionalRangeIds;
    }
    return ids;
  }

  completedUnitIds(context) {
    const units = context.units();
    const unitByIdentities = new Map(units.map((unit) => [
      JSON.stringify(unit.findings.map((finding) => finding.identity.toString()).sort()), unit.id,
    ]));
    const ids = this.groups().map((group) => {
      const key = JSON.stringify(group.findingIdentities.map((identity) => (
        new FlowFindingSourceIdentity(identity).toString()
      )).sort());
      const unitId = unitByIdentities.get(key);
      if (unitId === undefined) throw new Error("Gate repair publication has a foreign atomic unit");
      return unitId;
    });
    if (new Set(ids).size !== ids.length) throw new Error("Gate repair published an atomic unit twice");
    return Object.freeze(ids);
  }
}
