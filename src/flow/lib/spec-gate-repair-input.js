import { createHash } from "node:crypto";
import { loadMergedGuardrails, filterByPhase } from "../../lib/guardrail.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { buildAcknowledgedRationaleSection } from "./acknowledged-rationale.js";
import { canonicalSourceFindings } from "./flow-findings.js";
import { canonicalPlanGateRepairForTarget, PlanGateRepairObservation } from "./plan-gate-repair.js";
import { SpecGateRepairContext } from "./spec-gate-repair-context.js";
import { specRepairTargetEntries } from "./spec-repair-operations.js";
import { readSpecGateRepairSources } from "./spec-gate-repair-sources.js";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function key(value) { return JSON.stringify(value); }

/** The exact merged Spec rules and requirement fallback supplied to repair workers. */
export class SpecGateRepairRuleSet {
  constructor({ executionRoot, spec }) {
    const rules = filterByPhase(loadMergedGuardrails(executionRoot), "spec");
    const byRule = new Map(rules.map((rule) => [rule.id, rule]));
    for (const requirement of spec.requirements ?? []) {
      if (!byRule.has(requirement.id)) byRule.set(requirement.id, requirement);
    }
    this.guardrails = Object.freeze([...byRule.values()]);
    this.acknowledgedRationale = buildAcknowledgedRationaleSection({ spec, guardrails: rules });
    Object.freeze(this);
  }
}

/** One version-bound, permission-limited parent input for Gate repair. */
export class SpecGateRepairInput {
  constructor({ repair, spec, baseRevision, specByteLength, context, sourceDescriptor, review, attempt,
    observationIdentities }) {
    this.repair = repair;
    this.spec = Object.freeze(structuredClone(spec));
    this.baseRevision = baseRevision;
    this.specByteLength = specByteLength;
    this.context = context;
    this.sourceDescriptor = Object.freeze(structuredClone(sourceDescriptor));
    this.review = review;
    this.attempt = Object.freeze({ id: attempt.id, sequence: attempt.sequence });
    this.observationIdentities = Object.freeze(observationIdentities.map((identity) => Object.freeze(identity)));
    Object.freeze(this);
  }
}

/** Match Gate cycle observations to the existing four-part source finding identity. */
export function readSpecGateRepairInput({ flowManager, state, executionRoot, locations = null }) {
  if (state.current?.at(-1) !== "spec-gate-repair" || state.attempt === null) {
    throw new Error("Spec Gate repair input requires its active Attempt");
  }
  const repair = canonicalPlanGateRepairForTarget({ flowManager, state, targetStepId: "spec-gate-repair" });
  if (repair === null) throw new Error("Spec Gate repair has no exact Gate evidence");
  const specRead = flowManager.readArtifact({
    specId: state.specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair",
  });
  const spec = JSON.parse(specRead.bytes.toString("utf8"));
  const baseRevision = `sha256:${digest(specRead.bytes)}`;
  const gateRead = flowManager.readArtifact({
    specId: state.specId, logicalKey: "spec.gate", consumerNodeId: "spec-gate-repair",
  });
  if (gateRead.descriptor.activityId !== repair.evidenceIdentity.publicationActivityId) {
    throw new Error("Spec Gate repair source publication changed");
  }
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "spec.gate", bytes: gateRead.bytes,
  });
  const source = canonicalSourceFindings({
    artifact: history.current.payload,
    sourceStep: "spec-gate",
    sourceArtifact: gateRead.relativePath,
  });
  const byGateFingerprint = new Map();
  for (const entry of source) {
    const observation = new PlanGateRepairObservation({
      ...entry.finding, phase: "spec", scope: "flow", taskId: null,
    });
    const matches = byGateFingerprint.get(observation.fingerprint.toString()) ?? [];
    matches.push(entry);
    byGateFingerprint.set(observation.fingerprint.toString(), matches);
  }
  const findings = repair.observations.map((observation) => {
    const matches = byGateFingerprint.get(observation.fingerprint.toString()) ?? [];
    if (matches.length !== 1) throw new Error("Gate repair observation has no unique canonical source finding");
    return {
      identity: matches[0].identity.toJSON(),
      requirementRef: observation.requirementRef,
      observed: observation.observed,
      where: observation.where?.toJSON() ?? null,
      targets: matches[0].finding.targets ?? [],
      allowedTargets: matches[0].finding.allowedTargets ?? [],
    };
  });
  const ruleSet = new SpecGateRepairRuleSet({ executionRoot, spec });
  const sources = readSpecGateRepairSources({ flowManager, state, executionRoot, spec });
  let context = new SpecGateRepairContext({
    spec, baseRevision, findings, guardrails: ruleSet.guardrails, sources,
    acknowledgedRationale: ruleSet.acknowledgedRationale,
  });
  if (locations !== null) context = context.resolveLocations({ baseRevision, locations });
  if (context.unresolvedFindings().length === 0) {
    const inventory = new Map(specRepairTargetEntries(spec).map((entry) => [key(entry.target.toJSON()), entry]));
    const permissions = new Map();
    for (const unit of context.units()) {
      const selected = context.select(unit.id);
      for (const finding of unit.findings) {
        const grants = new Map();
        for (const permission of finding.allowedTargets) {
          const entry = inventory.get(key(permission.target));
          if (entry === undefined || !Array.isArray(permission.operationKinds)
            || permission.operationKinds.some((kind) => !entry.operationKinds.includes(kind))) {
            throw new Error("Spec Gate explicit repair permission is outside canonical Spec inventory");
          }
          grants.set(key(permission.target), { target: permission.target,
            operationKinds: [...permission.operationKinds] });
        }
        const textTargets = selected.ranges.filter((range) => (
          finding.rangeIds.includes(range.id) && range.target !== null
          && inventory.get(key(range.target))?.operationKinds.includes("edit-text-field")
        ));
        for (const range of textTargets) {
          const existing = grants.get(key(range.target));
          grants.set(key(range.target), { target: range.target,
            operationKinds: [...new Set([...(existing?.operationKinds ?? []), "edit-text-field"])] });
        }
        permissions.set(finding.identity.toString(), [...grants.values()]);
      }
    }
    context = new SpecGateRepairContext({
      spec, baseRevision, guardrails: ruleSet.guardrails, sources,
      acknowledgedRationale: ruleSet.acknowledgedRationale,
      findings: context.units().flatMap((unit) => unit.findings.map((finding) => ({
        ...finding.toJSON(), allowedTargets: permissions.get(finding.identity.toString()) ?? [],
      }))),
    });
  }
  const review = flowManager.readLatestSpecReview({
    specId: state.specId, consumerNodeId: "spec-gate-repair",
  });
  return new SpecGateRepairInput({ repair, spec, baseRevision, specByteLength: specRead.bytes.length, context,
    sourceDescriptor: gateRead.descriptor, review, attempt: state.attempt,
    observationIdentities: findings.map((finding) => finding.identity) });
}
