import { ApprovalResultEvidence } from "../engine/step-result.js";

/** Save-only access to the canonical approval, Tasks, initial plan and activation transaction. */
export class ApprovalSettlementWriter {
  #flowManager;
  #specId;
  #approval;
  #plan;
  #specRecordPublication;
  #expectedSpecDigest;

  constructor({ flowManager, specId, approval = null, plan = null, specRecordPublication = null, expectedSpecDigest = null } = {}) {
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#approval = approval;
    this.#plan = plan;
    this.#specRecordPublication = specRecordPublication;
    this.#expectedSpecDigest = expectedSpecDigest;
  }

  settle({ stepResult, settlement, evidence }) {
    if (!(evidence instanceof ApprovalResultEvidence)) throw new TypeError("Approval settlement requires its acquired source evidence");
    const binding = { runId: evidence.runId, specId: evidence.specId,
      stepId: "approval", attempt: evidence.attempt };
    return this.#flowManager.commitSpecStepResult({ specId: this.#specId,
      binding, stepResult, settlement, approval: this.#approval, plan: this.#plan,
      specRecordPublication: this.#specRecordPublication, expectedSpecDigest: this.#expectedSpecDigest });
  }
}
