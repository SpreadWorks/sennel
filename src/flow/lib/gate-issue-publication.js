import { createHash } from "node:crypto";

function jsonClone(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Exact issue-log evidence owned by one prospective Gate settlement. */
export class GateIssuePublication {
  constructor({ binding, entry, phase, stepId = `${phase}-gate` } = {}) {
    if (binding?.stepId !== stepId || typeof binding?.runId !== "string"
      || typeof binding?.specId !== "string" || typeof binding?.attempt?.id !== "string"
      || !Number.isSafeInteger(binding?.attempt?.sequence)) {
      throw new Error("Gate issue publication requires its exact Attempt binding");
    }
    const source = jsonClone(entry, "Gate issue publication entry");
    if (source.step !== binding.stepId || source.phase !== phase
      || source.trigger !== "gate post hook (auto)" || !Number.isFinite(Date.parse(source.timestamp))) {
      throw new Error("Gate issue publication entry is invalid");
    }
    delete source.issueLogId;
    const issueLogId = `${binding.stepId}-result-${createHash("sha256").update(stableJson({
      runId: binding.runId,
      specId: binding.specId,
      attempt: { id: binding.attempt.id, sequence: binding.attempt.sequence },
      entry: source,
    })).digest("hex")}`;
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });
    this.entry = Object.freeze({ ...source, issueLogId });
    Object.freeze(this);
  }

  matches(binding) {
    return binding?.runId === this.binding.runId
      && binding?.specId === this.binding.specId
      && binding?.stepId === this.binding.stepId
      && binding?.attempt?.id === this.binding.attemptId
      && binding?.attempt?.sequence === this.binding.attemptSequence;
  }

  toJSON() { return { binding: { ...this.binding }, entry: structuredClone(this.entry) }; }
}

export class DraftGateIssuePublication extends GateIssuePublication {
  constructor({ binding, entry } = {}) { super({ binding, entry, phase: "draft" }); }
}

export class SpecGateIssuePublication extends GateIssuePublication {
  constructor({ binding, entry } = {}) {
    if (!["spec", "task-spec"].includes(entry?.phase)) {
      throw new Error("Spec Gate issue publication phase is invalid");
    }
    super({ binding, entry, phase: entry.phase, stepId: "spec-gate" });
  }
}
