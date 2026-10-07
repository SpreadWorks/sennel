import { createHash } from "node:crypto";
import { readSpecJsonValidator } from "../../lib/spec-json.js";
import { loadMergedGuardrails, filterByPhase } from "../../lib/guardrail.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { buildAcknowledgedRationaleSection } from "./acknowledged-rationale.js";
import { canonicalSourceFindings } from "./flow-finding-source.js";
import { canonicalPlanGateRepairForTarget, PlanGateRepairObservation } from "./plan-gate-repair.js";
import { SpecGateRepairContext } from "./spec-gate-repair-context.js";
import { SpecGateTargetSelection } from "./spec-gate-targets.js";
import { readSpecGateRepairSources } from "./spec-gate-repair-sources.js";
import { SpecGateRepairInput, SpecGateRepairSourceSnapshots } from "./spec-gate-repair-values.js";

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

/** Match Gate cycle observations to the existing four-part source finding identity. */
export function readSpecGateRepairInput({ flowManager, state, executionRoot, locations = null, sourceSnapshots = null, captureBudget }) {
  if (sourceSnapshots !== null && !(sourceSnapshots instanceof SpecGateRepairSourceSnapshots)) {
    throw new TypeError("Gate repair source restoration requires its typed canonical snapshot");
  }
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
    const sourceFinding = matches[0].finding;
    if (sourceFinding.requirementRef !== observation.requirementRef
      || sourceFinding.observed !== observation.observed
      || key(sourceFinding.where ?? null) !== key(observation.where?.toJSON() ?? null)) {
      throw new Error("Spec Gate repair observation differs from its canonical source");
    }
    if (sourceFinding.specRevision !== baseRevision || observation.specRevision !== baseRevision) {
      throw new Error("Spec Gate repair target revision is stale or absent");
    }
    const selection = new SpecGateTargetSelection({ targets: sourceFinding.targets,
      allowedTargets: sourceFinding.allowedTargets, spec, specRevision: baseRevision });
    if (key(selection.toJSON()) !== key(observation.targets)
      || key(selection.allowedTargets) !== key(observation.allowedTargets)) {
      throw new Error("Spec Gate repair target authority differs from its canonical source");
    }
    return {
      identity: matches[0].identity.toJSON(),
      requirementRef: observation.requirementRef,
      observed: observation.observed,
      where: observation.where?.toJSON() ?? null,
      targets: selection.toJSON(),
      allowedTargets: selection.allowedTargets,
      specRevision: selection.specRevision,
    };
  });
  const ruleSet = new SpecGateRepairRuleSet({ executionRoot, spec });
  const sources = sourceSnapshots === null ? readSpecGateRepairSources({ flowManager, state, executionRoot, spec, captureBudget })
    : sourceSnapshots.sources();
  let context = new SpecGateRepairContext({
    spec, baseRevision, findings, guardrails: ruleSet.guardrails, sources,
    acknowledgedRationale: ruleSet.acknowledgedRationale,
  });
  if (locations !== null) context = context.resolveLocations({ baseRevision, locations });
  const review = flowManager.readLatestSpecReview({
    specId: state.specId, consumerNodeId: "spec-gate-repair",
  });
  return new SpecGateRepairInput({ repair, spec, baseRevision, specByteLength: specRead.bytes.length, context,
    sourceDescriptor: gateRead.descriptor, review, attempt: state.attempt,
    observationIdentities: findings.map((finding) => finding.identity), validator: readSpecJsonValidator() });
}
