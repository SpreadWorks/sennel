import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DraftGateRepairSelection } from "./draft-gate-repair-selection.js";
import { stepResultDigest } from "../../engine/step-result.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state.js";
import { DraftRepairResultFacts, draftQuestionsRepairResult, draftCoverageRepairResult, draftGateRepairResult } from "./draft-repair-result.js";
import { applyDraftRepairOperations, DraftGateRepairAuthority, DraftRepairOperationsError } from "../../lib/draft-repair-operations.js";
import { PlanGateRepairOutcomeDraft } from "../../lib/gate-observation-convergence.js";

/** Immutable semantic inputs; the Service owns their artifact addresses and provenance. */
export class DraftRepairInput {
  constructor({ stepId, draft, triage = null, repair, inputRevision, gate = null }) {
    this.stepId = stepId;
    this.draft = draft;
    this.triage = triage;
    this.repair = repair;
    this.inputRevision = inputRevision;
    this.gate = gate;
    Object.freeze(this);
  }
}

/** One Step-owned application of the existing bounded operation contract. */
export class DraftRepairCandidate {
  constructor(input) {
    if (!(input instanceof DraftRepairInput)) throw new TypeError("Draft repair requires typed input");
    const applied = applyDraftRepairOperations({
      draft: input.draft, triage: input.triage, repair: input.repair,
      inputRevision: input.inputRevision, phase: input.stepId,
      authority: input.gate === null ? null : new DraftGateRepairAuthority(input.gate.repair),
    });
    this.input = input;
    this.draft = applied.draft;
    this.changed = !isDeepStrictEqual(this.draft, input.draft);
    this.outcome = null;
    this.audit = applied.audit;
    this.resultFacts = input.gate === null
      ? new DraftRepairResultFacts({ stepId: input.stepId, draftChanged: this.changed }) : null;
    if (input.gate !== null) {
      const { repair, record, workerReport, beforeDigest } = input.gate;
      const outputDigest = this.changed
        ? createHash("sha256").update(`${JSON.stringify(this.draft, null, 2)}\n`).digest("hex") : beforeDigest;
      let report;
      try {
        report = workerReport.bindArtifact({
          repair, beforeEvidenceDigest: beforeDigest, outputEvidenceDigest: outputDigest,
          deltaIds: this.changed ? [outputDigest] : [],
        });
        this.outcome = new PlanGateRepairOutcomeDraft({
          repair, disposition: this.changed ? "applied" : "rejected-no-progress", report,
        });
        this.outcome.seal("plan-gate-repair-outcome-validation");
      } catch (cause) {
        throw new DraftRepairOperationsError("FLOW_ARTIFACT_HANDOFF_INVALID", cause.message, applied.audit);
      }
      this.audit = Object.freeze({
        ...applied.audit,
        sourceIssueLogId: record.sourceIssueLogId,
        sourceEntryDigest: record.sourceEntryDigest,
        resultLogicalKey: record.connector.resultLogicalKey,
        catalogFingerprint: record.connector.catalogFingerprint,
        report: report.toJSON(),
      });
    }
    this.result = input.gate !== null ? draftGateRepairResult(this.outcome)
      : input.stepId === "draft-questions-repair" ? draftQuestionsRepairResult(this.resultFacts)
        : draftCoverageRepairResult(this.resultFacts);
    this.selection = this.outcome === null ? null : new DraftGateRepairSelection({ result: this.result, outcome: this.outcome });
    this.resultDigest = stepResultDigest(this.result);
    Object.freeze(this);
  }

  assertResult(result) {
    if (result?.stepId !== this.result.stepId || stepResultDigest(result) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Draft Result differs from its selected repair candidate");
    }
  }

}
