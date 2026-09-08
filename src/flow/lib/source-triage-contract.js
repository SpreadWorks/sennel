import { requiredText, exactKeys } from "./source-effect-fields.js";
import { ApprovedFindingExceptionSet } from "./acknowledged-rationale.js";

const MAX_DISPOSITIONS = 256;



export class SourceTriageDisposition {
  constructor(value = {}) {
    exactKeys(value, ["findingKey", "disposition", "basis", "rationale"], "source triage disposition");
    this.findingKey = requiredText(value.findingKey, "source triage findingKey");
    this.disposition = requiredText(value.disposition, "source triage disposition");
    if (!new Set(["apply", "reject"]).has(this.disposition)) throw new Error("source triage disposition is invalid");
    this.basis = requiredText(value.basis, "source triage basis");
    const allowedBases = this.disposition === "apply"
      ? new Set(["repair-required"])
      : new Set(["not-applicable", "already-satisfied", "finding-invalid", "approved-exception"]);
    if (!allowedBases.has(this.basis)) throw new Error("source triage basis is invalid for its disposition");
    this.rationale = requiredText(value.rationale, "source triage rationale");
    if (this.rationale.length < 20) throw new Error("source triage rationale must be at least 20 characters");
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingKey: this.findingKey,
      disposition: this.disposition,
      basis: this.basis,
      rationale: this.rationale,
    };
  }
}

/** Shared semantic contract for Flow and Task finding triage. */
export class SourceTriageEffect {
  constructor(value = {}) {
    exactKeys(value, ["version", "dispositions"], "source triage effect");
    if (value.version !== 1) throw new Error("source triage effect version must be 1");
    if (!Array.isArray(value.dispositions) || value.dispositions.length > MAX_DISPOSITIONS) {
      throw new Error("source triage dispositions are invalid");
    }
    this.dispositions = Object.freeze(value.dispositions.map((entry) => (
      entry instanceof SourceTriageDisposition ? entry : new SourceTriageDisposition(entry)
    )));
    if (new Set(this.dispositions.map((entry) => entry.findingKey)).size !== this.dispositions.length) {
      throw new Error("source triage dispositions must not duplicate findingKey");
    }
    Object.freeze(this);
  }

  assertCanonicalFindings(findings, { approvedExceptions = null } = {}) {
    if (!Array.isArray(findings)) throw new Error("source triage requires canonical findings");
    if (approvedExceptions !== null && !(approvedExceptions instanceof ApprovedFindingExceptionSet)) {
      throw new Error("source triage approved exceptions require typed canonical authority");
    }
    const byKey = new Map(findings.map((finding) => [finding?.findingKey, finding]));
    if (byKey.size !== findings.length || byKey.has(undefined)
      || this.dispositions.length !== findings.length
      || this.dispositions.some((entry) => !byKey.has(entry.findingKey))) {
      throw new Error("source triage must classify each canonical finding exactly once");
    }
    for (const decision of this.dispositions) {
      const classification = byKey.get(decision.findingKey)?.disposition;
      if (!new Set(["must-fix", "informational", "deferred"]).has(classification)) {
        throw new Error(`canonical finding ${decision.findingKey} has an invalid disposition`);
      }
      if (classification !== "must-fix") {
        if (decision.disposition !== "reject" || decision.basis !== "not-applicable") {
          throw new Error(`non-repair finding ${decision.findingKey} must be rejected as not-applicable`);
        }
        continue;
      }
      if (decision.disposition === "apply") continue;
      if (decision.basis === "not-applicable") {
        throw new Error(`must-fix finding ${decision.findingKey} requires a concrete rejection basis`);
      }
      if (decision.basis === "approved-exception") {
        if (approvedExceptions === null || !approvedExceptions.allows(byKey.get(decision.findingKey))) {
          throw new Error(`must-fix finding ${decision.findingKey} lacks approved exception authority`);
        }
      }
    }
    return this;
  }

  toJSON() { return { version: 1, dispositions: this.dispositions.map((entry) => entry.toJSON()) }; }
}
