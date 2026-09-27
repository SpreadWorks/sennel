/** One-way projection of the retired Spec Gate repair question receipt. */
import crypto from "node:crypto";
import fs from "node:fs";

import { FlowArtifactCatalog, FlowVersionLocation } from "./flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "./flow-artifact-contract.js";
import { FlowManager } from "./flow-manager.js";
import { FlowActivity, CurrentFlowDefinition, CurrentFlowState } from "../flow/lib/current-flow-state.js";
import { SpecGateRepairContext } from "../flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairRuleSet } from "../flow/lib/spec-gate-repair-input.js";
import { readSpecGateRepairSources } from "../flow/lib/spec-gate-repair-sources.js";

const OLD_RESULT = "spec-gate-repair-awaiting-decision";
const NEW_RESULT = "spec-gate-repair-context-required";
const OLD_STAGE = "spec-gate-repair-user-input";
const NEW_STAGE = "spec-gate-repair-draft-return";

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fail(message) { throw new Error(`CANONICAL_GATE_DECISION_MIGRATION_UNPROVEN: ${message}`); }
function parse(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not JSON`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  return value;
}
function resultIdentity(receipt) {
  const { id, ...identity } = receipt;
  return digest(Buffer.from(JSON.stringify(identity)));
}

/** Read existing catalog authorities without hydrating a retired runtime Result. */
class MigrationArtifactReader {
  constructor({ location, catalog }) {
    this.location = location;
    this.catalog = catalog;
    Object.freeze(this);
  }

  readArtifact({ logicalKey, optional = false }) {
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey);
    const descriptor = this.catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath) ?? null;
    if (descriptor === null) {
      if (optional) return null;
      fail(`canonical source artifact is absent: ${logicalKey}`);
    }
    if (descriptor.logicalKey !== logicalKey) fail(`canonical source artifact has another Catalog identity: ${logicalKey}`);
    return Object.freeze({
      descriptor,
      relativePath: descriptor.relativePath,
      bytes: fs.readFileSync(this.location.resolve(descriptor.relativePath)),
    });
  }
}

/** Immutable, catalog-bound transformation for one canonical Version. */
export class CanonicalGateDecisionMigrationPlan {
  constructor({ location, definition }) {
    if (!(location instanceof FlowVersionLocation) || !(definition instanceof CurrentFlowDefinition)) {
      throw new TypeError("Gate decision migration requires a canonical Version and Definition");
    }
    this.location = location;
    this.definition = definition;
    Object.freeze(this);
  }

  inspect() {
    this.location.assertAuthority();
    const flowBytes = fs.readFileSync(this.location.flowStateFile);
    const activitiesBytes = fs.readFileSync(this.location.activitiesFile);
    const catalogBytes = fs.readFileSync(this.location.catalogFile);
    const state = parse(flowBytes, "Flow state");
    if (activitiesBytes.length > 0 && !activitiesBytes.toString("utf8").endsWith("\n")) fail("Activity ledger has a partial line");
    const activities = activitiesBytes.length === 0 ? [] : activitiesBytes.toString("utf8").trimEnd()
      .split("\n").map((line, index) => parse(Buffer.from(line), `Activity ${index + 1}`));
    const old = activities.filter((entry) => entry.result?.stepResult?.kind === OLD_RESULT);
    if (old.length === 0) return null;
    if (activities.length !== state.confirmationOrder) fail("Flow and Activity confirmation orders differ");
    if (state.schemaRevision !== 4 || state.specId !== this.location.specId.toString()) {
      fail("Flow schema or Spec identity differs from the canonical Version");
    }
    const catalog = new FlowArtifactCatalog(parse(catalogBytes, "artifact Catalog"));
    catalog.verify(this.location);
    for (const [name, key] of [["flow.json", "flow.state"], ["activities.jsonl", "flow.activities"], ["spec.json", "spec.record"]]) {
      if (catalog.resolve(name).logicalKey !== key) fail(`Catalog does not bind ${name}`);
    }
    const activeOld = state.current === "spec-gate-repair" && state.attempt !== null
      ? old.filter((entry) => entry.attemptId === state.attempt.id
        && entry.sequence === state.attempt.sequence) : [];
    if (activeOld.length > 1) fail("active repair Attempt has multiple retired question settlements");
    let evidenceDigest = null;
    if (activeOld.length === 1) {
      const sourceReader = new MigrationArtifactReader({ location: this.location, catalog });
      const spec = parse(fs.readFileSync(this.location.specFile), "canonical Spec record");
      const flowManager = new FlowManager({
        root: this.location.repositoryRoot,
        mainRoot: this.location.repositoryRoot,
        inWorktree: false,
        specId: state.specId,
        specRoot: this.location.specRoot,
      });
      const executionRoot = flowManager.resolveWorktreePaths(state).worktreePath
        ?? this.location.repositoryRoot;
      if (!fs.existsSync(executionRoot) || !fs.statSync(executionRoot).isDirectory()) {
        fail(`Flow execution root is unavailable: ${executionRoot}`);
      }
      const sources = readSpecGateRepairSources({
        flowManager: sourceReader,
        state,
        executionRoot,
        spec,
      });
      const ruleSet = new SpecGateRepairRuleSet({ executionRoot, spec });
      evidenceDigest = SpecGateRepairContext.evidenceDigestFor({
        sources, guardrails: ruleSet.guardrails,
      });
    }
    // The Flow tree itself contains no retired Result in the active Await case.
    // A completed historical node may contain one, so project it as well.
    const projectedState = structuredClone(state);
    const projectNode = (node) => {
      if (node.result?.stepResult?.kind === OLD_RESULT) node.result = this.#projectResult(node.result);
      for (const child of node.steps ?? []) projectNode(child);
    };
    projectNode(projectedState);
    const publications = new Map();
    const projectedActivities = activities.map((entry, index) => {
      if (entry.confirmationOrder !== index + 1) fail(`Activity ${index + 1} has an invalid confirmation order`);
      if (entry.result?.stepResult?.kind !== OLD_RESULT) return entry;
      this.#assertOldActivity(entry, state);
      const receipt = entry.result.draftSettlementReceipt;
      const path = `artifacts/spec-gate-repairs/${receipt.binding.attemptId}/progress/${receipt.executionLifecycle.binding.executionGeneration}-publication.json`;
      const descriptor = catalog.resolve(path);
      if (descriptor.logicalKey !== "spec.gate.repair.progress") fail(`old question publication has no Catalog authority: ${path}`);
      const bytes = fs.readFileSync(this.location.resolve(path));
      const progress = parse(bytes, `old question publication ${path}`);
      if (progress.phase !== "publication" || progress.attemptId !== receipt.binding.attemptId
        || progress.generation !== receipt.executionLifecycle.binding.executionGeneration
        || progress.requestDigest !== receipt.executionLifecycle.claim.requestDigest
        || progress.proposal?.stage !== OLD_STAGE
        || progress.proposal.baseRevision !== progress.context?.baseRevision
        || typeof progress.proposal.question !== "string" || progress.proposal.question.trim() === ""
        || progress.context?.mode !== "repair" || !Array.isArray(progress.context.selections)
        || progress.context.selections.length === 0) {
        fail(`old question publication is not bound to its Attempt: ${path}`);
      }
      const unitIds = progress.context.selections.map((selection) => selection?.unit?.id);
      if (unitIds.some((id) => typeof id !== "string" || id === "")) fail("old repair context has no selected unit identity");
      const laterNotes = activities.filter((candidate) => (
        candidate.type === "note_recorded" && candidate.confirmationOrder > entry.confirmationOrder
      )).map((candidate) => ({ id: candidate.id, text: candidate.note?.text }));
      const replacement = {
        ...progress,
        context: activeOld.some((active) => active.id === entry.id)
          ? { ...progress.context, evidenceDigest } : progress.context,
        proposal: {
          version: 1,
          stage: NEW_STAGE,
          baseRevision: progress.proposal.baseRevision,
          unitId: unitIds[0],
          decision: progress.proposal.question,
          evidence: [
            `Migrated legacy worker question from ${path}; selected repair units: ${unitIds.join(", ")}. The original publication and Activity remain archived.`,
            ...laterNotes.map((note) => `Unverified related note Activity ${note.id}: ${note.text}`),
          ].join("\n"),
          unresolvedBecause: "The legacy worker record did not explain why existing canonical information could not settle this decision; Draft must review it with the saved evidence.",
        },
      };
      const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
      publications.set(path, { before: bytes, after: replacementBytes });
      return { ...entry, result: this.#projectResult(entry.result) };
    });
    const ids = new Set(old.map((entry) => entry.id));
    if (ids.size !== old.length || publications.size !== old.length) fail("old question settlements are not one-to-one with publications");
    const newActivitiesBytes = Buffer.from(projectedActivities.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    for (const entry of projectedActivities) FlowActivity.fromSerialized(entry);
    new CurrentFlowState(projectedState, { definition: this.definition });
    return Object.freeze({
      state, catalog, flowBytes, activitiesBytes, catalogBytes,
      projectedFlowBytes: Buffer.from(`${JSON.stringify(projectedState, null, 2)}\n`),
      projectedActivitiesBytes: newActivitiesBytes,
      publications, oldActivityIds: Object.freeze([...ids]),
    });
  }

  #assertOldActivity(activity, state) {
    const receipt = activity.result?.draftSettlementReceipt;
    const stepResult = activity.result?.stepResult;
    if (activity.nodeId !== "spec-gate-repair" || activity.transition?.operation !== "record_draft_step_settlement"
      || activity.type !== "result_confirmed" || stepResult?.type !== "user-input-required"
      || receipt?.resultKind !== OLD_RESULT || receipt?.resultType !== stepResult.type
      || receipt?.binding?.runId !== state.runId || receipt.binding.specId !== state.specId
      || receipt.binding.stepId !== activity.nodeId || receipt.binding.attemptId !== activity.attemptId
      || receipt.binding.attemptSequence !== activity.sequence
      || receipt.settlementKind !== "await" || receipt.executionLifecycle?.phase !== "publication"
      || receipt.resultDigest !== digest(Buffer.from(JSON.stringify(stepResult)))
      || receipt.id !== resultIdentity(receipt)) {
      fail(`old question Activity has no exact settlement identity: ${activity.id}`);
    }
  }

  #projectResult(result) {
    const stepResult = { kind: NEW_RESULT, type: "loop-required" };
    const receipt = {
      ...result.draftSettlementReceipt,
      resultKind: NEW_RESULT,
      resultType: stepResult.type,
      resultDigest: digest(Buffer.from(JSON.stringify(stepResult))),
      settlementKind: "execution",
    };
    receipt.id = resultIdentity(receipt);
    return { ...result, stepResult, draftSettlementReceipt: receipt };
  }
}
