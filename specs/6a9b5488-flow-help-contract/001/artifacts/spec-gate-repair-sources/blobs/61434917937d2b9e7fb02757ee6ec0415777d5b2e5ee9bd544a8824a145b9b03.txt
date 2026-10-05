/** A producer protocol rejection, retained with its unpublished checkpoint. */
export class DraftWorkerRejection {
  constructor({ code, message } = {}) {
    if (!["FLOW_DRAFT_GATE_REPAIR_INVALID", "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID"].includes(code)
      || typeof message !== "string" || message.trim() === "") {
      throw new TypeError("Draft worker rejection requires a supported protocol diagnostic");
    }
    this.code = code;
    this.message = message;
    Object.freeze(this);
  }

  static fromJSON(value) {
    if (!value || Object.keys(value).sort().join(",") !== "code,message") {
      throw new TypeError("Draft worker rejection has an invalid schema");
    }
    return new this(value);
  }

  static fromFailure(error) {
    if (error?.classification !== "invalid" || error.recoveryPossible === true) return null;
    if (error.code === "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID") return new this(error);
    if (error.code !== "FLOW_DRAFT_GATE_REPAIR_INVALID") return null;
    const audit = error.data?.draftRepairAudit;
    if (!audit || audit.discardedOperations.some((operation) => (
      ["unauthorized operation", "stale target"].includes(operation.reason)
    ))) return null;
    return new this(error);
  }

  toJSON() { return { code: this.code, message: this.message }; }
}

/** The durable protocol budget. Semantic Gate retry consumption is separate. */
export class DraftWorkerCorrectionBudget {
  constructor(used) {
    if (!Number.isSafeInteger(used) || used < 0) throw new TypeError("Draft correction consumption is invalid");
    this.used = used;
    this.limit = 2;
    this.exhausted = used > this.limit;
    Object.freeze(this);
  }
}

/** Definition policy for bounded producer correction, independent of semantic retries. */
export class DraftWorkerCorrectionPlan {
  constructor({ state, activities }) {
    const attempt = state.attempt;
    const receipts = activities.map((entry) => entry.toJSON?.() ?? entry)
      .filter((entry) => entry.nodeId === "draft-gate-repair"
        && entry.attemptId === attempt?.id && entry.sequence === attempt?.sequence)
      .map((entry) => entry.result?.draftSettlementReceipt)
      .filter((receipt) => receipt?.executionLifecycle);
    const latest = receipts.at(-1)?.executionLifecycle;
    const rejections = receipts.filter((receipt) => receipt.executionLifecycle.rejection != null);
    const last = rejections.at(-1)?.executionLifecycle;
    // A transport retry may claim a later generation without publishing a
    // candidate. Keep the same feedback until publication starts a new cycle;
    // exact replay of that publication still needs its original instructions.
    const feedbackConsumed = receipts.some(({ executionLifecycle: execution }) => (
      ["publication", "terminal"].includes(execution.phase)
      && execution.binding.executionGeneration >= last?.binding.executionGeneration
      && execution.binding.executionGeneration < latest?.binding.executionGeneration
    ));
    const active = state.current?.at(-1) === "draft-gate-repair"
      && state.lifecycle.state === "active" && attempt?.failure === null;
    const budget = new DraftWorkerCorrectionBudget(rejections.length);
    this.used = budget.used;
    this.limit = budget.limit;
    this.exhausted = active && latest?.phase === "checkpoint"
      && latest.rejection != null && budget.exhausted;
    this.continue = active && latest?.phase === "checkpoint"
      && latest.rejection != null && !this.exhausted;
    this.feedback = active && last && !feedbackConsumed ? Object.freeze({
      ...DraftWorkerRejection.fromJSON(last.rejection).toJSON(),
      classification: "invalid",
      remainingCalls: Math.max(0, this.limit + 1 - this.used),
    }) : null;
    Object.freeze(this);
  }
}

export function resolveDraftWorkerCorrection(facts) {
  return new DraftWorkerCorrectionPlan(facts);
}
