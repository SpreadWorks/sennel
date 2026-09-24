/** Migration-only proof for canonical Flow states saved before Spec Gate repair became a leaf. */
import crypto from "node:crypto";
import fs from "node:fs";

import { FlowArtifactCatalog } from "./flow-version.js";
import {
  GateObservationCycleReader, GateObservationOccurrence, GateObservationRepair, PlanGateRepairOutcome,
} from "../flow/lib/gate-observation-convergence.js";
import { PlanGateRepairObservation } from "../flow/lib/plan-gate-repair.js";
import {
  CURRENT_FLOW_SCHEMA_REVISION,
  CurrentFlowDefinition,
  CurrentFlowState,
  FlowActivity,
  FlowDefinitionNode,
} from "../flow/lib/current-flow-state.js";

const OLD_APPLIED = "spec-plan-gate-repair-applied";
const OLD_NO_PROGRESS = "spec-plan-gate-repair-no-progress";

function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(message) { throw new Error(`CANONICAL_GATE_REPAIR_MIGRATION_UNPROVEN: ${message}`); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function oldRepairFingerprint(record) {
  const identity = {
    version: record.version, runId: record.runId, specId: record.specId,
    issue: record.issue, phase: record.phase, connector: record.connector,
    evidenceIdentity: record.evidenceIdentity, sourceIssueLogId: record.sourceIssueLogId,
    sourceEntryDigest: record.sourceEntryDigest,
    observationFingerprints: record.observationFingerprints,
    observationRequests: record.observationRequests,
  };
  return hash(Buffer.from(stableStringify(identity)));
}

function parse(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not JSON`); }
  if (!object(value)) fail(`${label} is not an object`);
  return value;
}

function firstDifference(left, right, location = "flow") {
  if (Object.is(left, right)) return null;
  if (!object(left) && !Array.isArray(left) || !object(right) && !Array.isArray(right)) return location;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const difference = firstDifference(left[key], right[key], `${location}.${key}`);
    if (difference !== null) return difference;
  }
  return null;
}

function nodes(root, result = []) {
  if (!object(root) || !Array.isArray(root.steps)) fail("flow tree has an invalid node");
  result.push(root);
  for (const child of root.steps) nodes(child, result);
  return result;
}

function assertOldTree(actual, template, definition, parentId = null) {
  if (!object(actual) || actual.kind !== template.kind || actual.id !== template.id
    || actual.key !== template.key || !Array.isArray(actual.steps)) {
    fail(`old Flow tree differs from the canonical Definition at ${template.id}`);
  }
  const expected = template.steps.filter((child) => child.id !== "spec-gate-repair");
  const staticIds = new Set(expected.map((child) => child.id));
  const staticActual = actual.steps.filter((child) => staticIds.has(child.id));
  if (JSON.stringify(staticActual.map((child) => child.id)) !== JSON.stringify(expected.map((child) => child.id))) {
    fail(`old Flow tree has a missing or reordered static child at ${template.id}`);
  }
  const unknown = actual.steps.filter((child) => !staticIds.has(child.id));
  if (unknown.length > 0 && actual.id !== definition.dynamicTaskContainerId) {
    fail(`old Flow tree has an unexpected child at ${template.id}`);
  }
  for (const child of unknown) {
    if (child.kind !== "task") fail("old Flow tree has a non-Task dynamic child");
    const dynamic = definition.taskFrom({ id: child.id, key: child.key }).toJSON();
    assertOldTree(child, dynamic, definition, actual.id);
  }
  for (let index = 0; index < expected.length; index += 1) {
    assertOldTree(staticActual[index], expected[index], definition, actual.id);
  }
  if (parentId === null && actual.kind !== "flow") fail("old Flow root is not a Flow node");
}

function activities(bytes) {
  if (bytes.length === 0) return [];
  if (!bytes.toString("utf8").endsWith("\n")) fail("old Activity ledger has a partial line");
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  const seen = new Set();
  return lines.map((line, index) => {
    const activity = parse(Buffer.from(line, "utf8"), `old Activity ${index + 1}`);
    if (activity.confirmationOrder !== index + 1 || typeof activity.id !== "string" || seen.has(activity.id)
      || activity.nodeId !== activity.transition?.nodeId) {
      fail(`old Activity ${index + 1} has invalid identity or order`);
    }
    seen.add(activity.id);
    return activity;
  });
}

function oldResultKind(result) { return result?.stepResult?.kind ?? null; }

function legacyDefinition(definition) {
  const removeNewLeaf = (node) => new FlowDefinitionNode({
    kind: node.kind, id: node.id, key: node.key, contract: node.contract, action: node.action,
    steps: node.steps.filter((child) => child.id !== "spec-gate-repair").map(removeNewLeaf),
  });
  return new CurrentFlowDefinition({
    root: removeNewLeaf(definition.root), taskTemplate: definition.taskTemplate,
    dynamicTaskContainerId: definition.dynamicTaskContainerId,
    dynamicTaskInsertionAfterId: definition.dynamicTaskInsertionAfterId,
  });
}

function projectedState(value) {
  const state = structuredClone(value);
  state.schemaRevision = CURRENT_FLOW_SCHEMA_REVISION;
  state.migration = null;
  for (const node of nodes(state)) {
    if (oldResultKind(node.result) !== OLD_APPLIED) continue;
    delete node.result.stepResult;
    delete node.result.draftSettlementReceipt;
  }
  return state;
}

function replayOldSpecGateRepair(state, activity, definition) {
  const result = activity.result;
  const attempt = activity.transition.attempt;
  const ordered = nodes(state.root.toJSON()).filter((node) => node.steps.length === 0);
  const target = ordered.findIndex((node) => node.id === "spec");
  const staticLeaves = nodes(definition.materializeRoot().toJSON()).filter((node) => node.steps.length === 0);
  const staticTarget = staticLeaves.findIndex((node) => node.id === "spec");
  const resetStepIds = staticLeaves.slice(staticTarget).map((node) => node.id);
  const checks = {
    sourceGate: state.current?.at(-1) === "spec-gate" && state.attempt?.id === activity.attemptId,
    targetSpec: attempt?.nodeId === "spec",
    resultKind: result?.stepResult?.kind === "spec-gate-repair-required",
    receipt: result?.draftSettlementReceipt?.binding?.stepId === "spec-gate"
      && result.draftSettlementReceipt?.targetStepId === "spec",
    resetSuffix: target >= 0 && staticTarget >= 0 && JSON.stringify(result?.draftSettlementReceipt?.effects?.resetStepIds)
      === JSON.stringify(resetStepIds),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length > 0) fail(`old Spec Gate repair transition ${activity.id} lacks ${failed.join(", ")} authority`);
  const oldSpec = state.findNode("spec");
  if (attempt.sequence !== oldSpec.attemptSequence + 1
    || attempt.consumption?.semantic !== 0 || attempt.consumption?.tooling !== 0
    || attempt.failure !== null) {
    fail(`old Spec Gate repair transition ${activity.id} has an invalid target Attempt`);
  }
  const confirmed = state.confirmCurrentAttempt({ result, status: "done" });
  const raw = confirmed.toJSON();
  const invalidated = new Set(ordered.slice(target).map((node) => node.id));
  const invalidate = (node) => {
    node.steps.forEach(invalidate);
    if (invalidated.has(node.id) || node.steps.some((child) => child.status === "invalidated")) {
      node.status = "invalidated";
      node.result = null;
    }
  };
  invalidate(raw);
  for (const id of definition.pathFor(state.root, "spec")) {
    const node = nodes(raw).find((entry) => entry.id === id);
    node.status = "in_progress";
    if (id === "spec") {
      node.result = null;
      node.attemptSequence = attempt.sequence;
    }
  }
  raw.current = "spec";
  raw.attempt = attempt.toJSON();
  return new CurrentFlowState(raw, { definition });
}

function replayOldAppliedSpecSettlement(state, activity, original, definition) {
  if (state.current?.at(-1) !== "spec" || state.attempt?.id !== activity.attemptId
    || activity.transition.operation !== "confirm_attempt"
    || activity.transition.status !== "done"
    || original.result?.draftSettlementReceipt?.targetStepId !== "spec-review") {
    fail(`old Spec Gate repair settlement ${activity.id} has no active Spec authority`);
  }
  const confirmed = state.confirmCurrentAttempt({ result: activity.result, status: "done" });
  const raw = confirmed.toJSON();
  const reconcile = (node) => {
    node.steps.forEach(reconcile);
    if (node.steps.some((child) => child.status === "invalidated")) {
      node.status = "invalidated";
      node.result = null;
    }
  };
  reconcile(raw);
  const routed = new CurrentFlowState(raw, { definition });
  if (routed.nextAction()?.nodeId !== "spec-review") {
    fail(`old Spec Gate repair settlement ${activity.id} did not reach Spec review`);
  }
  return routed;
}

function proveCompleteLedger(stateValue, projectedActivities, originalActivities, definition) {
  const priorDefinition = legacyDefinition(definition);
  const expected = new CurrentFlowState(projectedState(stateValue), { definition: priorDefinition });
  let replayed = CurrentFlowState.create({
    definition: priorDefinition,
    execution: expected.execution.toJSON(), version: expected.version,
    ...expected.identity.toJSON(), request: expected.request,
    lifecycle: { state: "active" }, policy: expected.policy.toJSON(),
    artifacts: expected.artifacts.toJSON(), outbox: expected.outbox.toJSON(), context: expected.context.toJSON(),
  });
  const preceding = [];
  for (let index = 0; index < projectedActivities.length; index += 1) {
    const value = projectedActivities[index];
    const activity = FlowActivity.fromSerialized(value);
    const node = replayed.findNode(activity.nodeId);
    if (node === null || node.key !== activity.nodeKey) {
      fail(`old Activity ${activity.id} does not identify a replayable Flow node`);
    }
    replayed = (oldResultKind(originalActivities[index].result) === OLD_APPLIED
      ? replayOldAppliedSpecSettlement(replayed, activity, originalActivities[index], priorDefinition)
      : activity.transition.operation === "plan_gate_repair"
      && activity.transition.attempt?.nodeId === "spec"
      ? replayOldSpecGateRepair(replayed, activity, priorDefinition)
      : activity.transition.apply(replayed, activity, { priorActivities: preceding }))
      .withConfirmationOrder(activity.confirmationOrder);
    preceding.push(activity);
  }
  if (JSON.stringify(replayed.toJSON()) !== JSON.stringify(expected.toJSON())) {
    const difference = firstDifference(replayed.toJSON(), expected.toJSON());
    fail(`old Activity ledger does not reproduce old Flow state at ${difference}${difference === "flow.status" ? ` (${replayed.root.status} != ${expected.root.status})` : ""}`);
  }
}

function assertOldResult(result, activity, state) {
  const stepResult = result.stepResult;
  const receipt = result.draftSettlementReceipt;
  if (activity.nodeId !== "spec" || activity.type !== "result_confirmed"
    || activity.transition?.operation !== "confirm_attempt"
    || activity.result?.outcome !== "passed"
    || JSON.stringify(stepResult) !== JSON.stringify({ kind: OLD_APPLIED, type: "completed" })
    || !object(receipt) || receipt.binding?.runId !== state.runId
    || receipt.binding?.specId !== state.specId || receipt.binding?.stepId !== "spec"
    || receipt.binding?.attemptId !== activity.attemptId
    || receipt.binding?.attemptSequence !== activity.sequence
    || receipt.resultKind !== OLD_APPLIED || receipt.resultType !== "completed"
    || receipt.resultDigest !== hash(Buffer.from(JSON.stringify(stepResult)))
    || receipt.settlementKind !== "target-connection" || receipt.targetStepId !== "spec-review"
    || JSON.stringify(receipt.effects) !== JSON.stringify({ skipStepIds: [], resetStepIds: [] })) {
    fail(`old Spec Gate repair Activity ${activity.id} is not a completed Spec settlement`);
  }
  const identity = {
    binding: receipt.binding,
    resultKind: receipt.resultKind,
    resultType: receipt.resultType,
    resultDigest: receipt.resultDigest,
    settlementKind: receipt.settlementKind,
    targetStepId: receipt.targetStepId,
    effects: receipt.effects,
    connector: receipt.connector,
    publicationDigest: receipt.publicationDigest,
    executionLifecycle: receipt.executionLifecycle,
    awaitQuestion: receipt.awaitQuestion,
    ...(receipt.draftGateRepairSelection === undefined ? {} : { draftGateRepairSelection: receipt.draftGateRepairSelection }),
  };
  if (receipt.id !== hash(Buffer.from(JSON.stringify(identity)))) {
    fail(`old Spec Gate repair Activity ${activity.id} has a forged settlement receipt`);
  }
}

/** Checked source bytes and old-cycle proof; no current-runtime compatibility is enabled. */
export class CanonicalGateRepairMigrationPreflight {
  constructor({ location, definition }) {
    this.location = location;
    this.definition = definition;
  }

  inspect() {
    this.location.assertAuthority();
    const flowBytes = fs.readFileSync(this.location.flowStateFile);
    const activitiesBytes = fs.readFileSync(this.location.activitiesFile);
    const catalogBytes = fs.readFileSync(this.location.catalogFile);
    const state = parse(flowBytes, "old flow.json");
    const catalog = new FlowArtifactCatalog(parse(catalogBytes, "old artifact-catalog.json"));
    catalog.verify(this.location);
    for (const [relativePath, logicalKey] of [["flow.json", "flow.state"], ["activities.jsonl", "flow.activities"], ["spec.json", "spec.record"]]) {
      if (catalog.resolve(relativePath).logicalKey !== logicalKey) fail(`old Catalog does not bind ${relativePath}`);
    }
    if (state.schemaRevision !== 3 || state.version !== 1 || state.specId !== this.location.specId.toString()
      || !Number.isSafeInteger(state.confirmationOrder) || state.confirmationOrder < 0) {
      fail("old Flow identity or schema revision is invalid");
    }
    if (state.attempt !== null) fail("old Flow has an in-flight Attempt");
    if (state.history !== null || Object.hasOwn(state, "migration")) {
      fail("old Flow is not a native canonical-v3 ledger without a migration checkpoint");
    }
    assertOldTree(state, this.definition.materializeRoot().toJSON(), this.definition);
    const ledger = activities(activitiesBytes);
    if (ledger.length !== state.confirmationOrder) fail("old Flow and Activity confirmation orders differ");
    const byId = new Map(ledger.map((activity) => [activity.id, activity]));
    const applied = ledger.filter((activity) => oldResultKind(activity.result) === OLD_APPLIED);
    if (ledger.some((activity) => oldResultKind(activity.result) === OLD_NO_PROGRESS)) {
      fail("old no-progress Spec Gate repair requires manual recovery before migration");
    }
    const oldKinds = new Set([OLD_APPLIED, OLD_NO_PROGRESS]);
    for (const node of nodes(state)) {
      if (oldKinds.has(oldResultKind(node.result)) && node.id !== "spec") {
        fail(`old Spec Gate repair result is attached to non-Spec node ${node.id}`);
      }
    }
    for (const activity of applied) assertOldResult(activity.result, activity, state);
    const projected = ledger.map((activity) => {
      if (oldResultKind(activity.result) !== OLD_APPLIED) return activity;
      const result = { ...activity.result };
      delete result.stepResult;
      delete result.draftSettlementReceipt;
      return { ...activity, result };
    });
    for (const activity of projected) FlowActivity.fromSerialized(activity);
    const projectedActivitiesBytes = Buffer.from(projected.map((activity) => `${JSON.stringify(activity)}\n`).join(""), "utf8");
    try { proveCompleteLedger(state, projected, ledger, this.definition); }
    catch (error) { fail(`old Activity replay failed: ${error.message}`); }
    const appliedIds = new Set(applied.map((activity) => activity.id));
    const outcomes = catalog.artifacts.filter((entry) => entry.logicalKey === "plan.gate.repair.outcome"
      && appliedIds.has(entry.activityId));
    let issueLog = null;
    let issueLogBytes = null;
    if (applied.length > 0) {
      const issueLogDescriptor = catalog.resolve("issue-log.json");
      if (issueLogDescriptor.logicalKey !== "issue.log") fail("old Catalog does not bind issue-log.json");
      issueLogBytes = fs.readFileSync(this.location.resolve("issue-log.json"));
      issueLog = parse(issueLogBytes, "old issue-log.json");
      if (!Array.isArray(issueLog.entries)) fail("old issue log has no entries");
    }
    const oldSpecEntries = issueLog?.entries.filter((entry) => entry?.kind === "plan-gate-repair"
      && entry.planGateRepair?.phase === "spec" && entry.planGateRepair?.targetStepId === "spec") ?? [];
    if (outcomes.length !== applied.length || oldSpecEntries.length !== applied.length) {
      fail("old Gate repair records and applied outcomes are incomplete");
    }
    const legacyCycles = { occurrences: [], repairs: [], outcomes: [] };
    for (const activity of applied) {
      const matching = outcomes.filter((entry) => entry.activityId === activity.id);
      if (matching.length !== 1) fail(`old Spec Gate repair Activity ${activity.id} has no unique outcome`);
      const outcome = PlanGateRepairOutcome.fromJSON(parse(
        fs.readFileSync(this.location.resolve(matching[0].relativePath)),
        `old Spec Gate repair outcome ${activity.id}`,
      ));
      const sourceActivity = byId.get(outcome.sourceEvidence.publicationActivityId);
      const sourceDescriptor = catalog.artifacts.find((entry) => entry.logicalKey === "spec.gate"
        && entry.activityId === outcome.sourceEvidence.publicationActivityId);
      const repairEntry = issueLog.entries.find((entry) => entry?.issueLogId === outcome.repairId);
      const record = repairEntry?.planGateRepair ?? null;
      const sourceEntry = issueLog.entries.find((entry) => entry?.issueLogId === record?.sourceIssueLogId);
      const recordFingerprint = record === null ? null : oldRepairFingerprint(record);
      const observations = record === null || !Array.isArray(record.observations)
        ? null : record.observations.map((value) => new PlanGateRepairObservation({
          ...value, phase: "spec", scope: "flow", taskId: null,
        }));
      const fingerprints = observations?.map((entry) => entry.fingerprint.toString()) ?? null;
      if (record === null || sourceActivity === undefined || record.version !== 2
        || record.runId !== state.runId || record.specId !== state.specId || record.issue !== state.issue
        || record.phase !== "spec" || record.targetStepId !== "spec"
        || record.connector?.sourceGateStepId !== "spec-gate" || record.connector?.targetStepId !== "spec"
        || record.connector?.catalogFingerprint !== record.evidenceIdentity?.catalogFingerprint
        || record.connector?.resultLogicalKey !== "spec.gate"
        || record.connector?.resultArtifactId !== "steps/spec-gate/result.json"
        || JSON.stringify(record.connector?.sourceAttempt) !== JSON.stringify(record.evidenceIdentity?.sourceAttempt)
        || JSON.stringify(fingerprints) !== JSON.stringify(record.observationFingerprints)
        || JSON.stringify(record.observationRequests?.map((entry) => entry.fingerprint))
          !== JSON.stringify(record.observationFingerprints)
        || repairEntry.issueLogId !== `plan-gate-repair-${recordFingerprint}`
        || sourceEntry?.issueLogId !== record.sourceIssueLogId
        || hash(Buffer.from(stableStringify(sourceEntry))) !== record.sourceEntryDigest) {
        fail(`old Spec Gate repair Activity ${activity.id} has no immutable issue-log repair record`);
      }
      const reference = sourceActivity?.references?.repairs?.[0];
      const exactRepair = new GateObservationRepair({
        repairId: repairEntry.issueLogId,
        sourceEvidence: record.evidenceIdentity,
        targetAttempt: sourceActivity?.transition?.attempt,
        publicationActivityId: sourceActivity?.id,
        recordFingerprint,
        handoffRevision: outcome.handoffRevision,
        requests: record.observationRequests,
      });
      if (outcome.disposition !== "applied" || outcome.publicationActivityId !== activity.id
        || outcome.targetAttempt.id !== activity.attemptId
        || outcome.targetAttempt.sequence !== activity.sequence
        || outcome.sourceEvidence.resultLogicalKey !== "spec.gate"
        || sourceActivity?.transition.operation !== "plan_gate_repair"
        || sourceActivity.nodeId !== "spec-gate"
        || sourceActivity.attemptId !== outcome.sourceEvidence.sourceAttempt.id
        || sourceActivity.sequence !== outcome.sourceEvidence.sourceAttempt.sequence
        || sourceActivity.confirmationOrder >= activity.confirmationOrder
        || reference?.id !== repairEntry.issueLogId || reference?.label !== record.sourceIssueLogId
        || (sourceDescriptor !== undefined && sourceDescriptor.hash !== outcome.sourceEvidence.catalogFingerprint)) {
        fail(`old Spec Gate repair Activity ${activity.id} has an unproven Gate outcome`);
      }
      outcome.assertRepair(exactRepair);
      legacyCycles.occurrences.push(...observations.map((observation) => new GateObservationOccurrence({
        evidence: exactRepair.sourceEvidence, observation: observation.canonical, blocking: true,
      }).toJSON()));
      legacyCycles.repairs.push(exactRepair.toJSON());
      legacyCycles.outcomes.push(outcome.toJSON());
    }
    GateObservationCycleReader.fromCanonical({
      observationRows: legacyCycles.occurrences,
      repairRows: legacyCycles.repairs,
      outcomeRows: legacyCycles.outcomes,
    }).read();
    const migratedRepairIds = new Set(legacyCycles.repairs.map((repair) => repair.repairId));
    const liveIssueLogBytes = issueLog === null ? null : Buffer.from(`${JSON.stringify({
      ...issueLog,
      entries: issueLog.entries.filter((entry) => !migratedRepairIds.has(entry?.issueLogId)),
    }, null, 2)}\n`, "utf8");
    const archived = Object.freeze({
      flow: hash(flowBytes), activities: hash(activitiesBytes), catalog: hash(catalogBytes),
      ...(issueLogBytes === null ? {} : { issueLog: hash(issueLogBytes) }),
    });
    return Object.freeze({
      state, catalog, flowBytes, activitiesBytes, catalogBytes, archiveDigests: archived,
      projectedActivitiesBytes,
      projectedActivitiesDigest: hash(projectedActivitiesBytes),
      legacyAppliedCount: applied.length,
      legacyOutcomeActivityIds: Object.freeze(applied.map((activity) => activity.id)),
      legacyCycles: Object.freeze(legacyCycles),
      legacyCyclesDigest: hash(Buffer.from(JSON.stringify(legacyCycles), "utf8")),
      issueLogBytes, liveIssueLogBytes,
    });
  }
}
