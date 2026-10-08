import { createHash } from "node:crypto";
import { TaskStepIdentity } from "./task-step-identity.js";
import { GateTransitionFacts } from "./gate-transition.js";
import { requiredString } from "./worker-artifact-handoff-error.js";

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

/** Stable issue-log id for one published Task Gate result. */
export function taskGateSettlementIssueLogId({ runId, nodeId, attempt, publicationActivityId, catalogFingerprint } = {}) {
  const attemptId = requiredString(attempt?.id, "Task Gate issue-log Attempt id");
  const sequence = Number.isSafeInteger(attempt?.sequence) && attempt.sequence > 0
    ? attempt.sequence
    : (() => { throw new Error("Task Gate issue-log Attempt sequence is invalid"); })();
  return `task-gate-${createHash("sha256").update(JSON.stringify({
    runId: requiredString(runId, "Task Gate issue-log runId"),
    nodeId: requiredString(nodeId, "Task Gate issue-log nodeId"),
    attemptId,
    sequence,
    publicationActivityId: requiredString(publicationActivityId, "Task Gate issue-log publication Activity id"),
    catalogFingerprint: requiredString(catalogFingerprint, "Task Gate issue-log catalog fingerprint"),
  })).digest("hex")}`;
}

/** Exact issue-log evidence owned by one prospective Gate settlement. */
export class GateIssuePublication {
  constructor({ binding, entry, phase, stepId = `${phase}-gate`, issueLogId: selectedIssueLogId = null } = {}) {
    if (binding?.stepId !== stepId || typeof binding?.runId !== "string"
      || typeof binding?.specId !== "string" || typeof binding?.attempt?.id !== "string"
      || !Number.isSafeInteger(binding?.attempt?.sequence)) {
      throw new Error("Gate issue publication requires its exact Attempt binding");
    }
    const nodeId = binding.nodeId ?? binding.stepId;
    const source = jsonClone(entry, "Gate issue publication entry");
    if (source.step !== nodeId || source.phase !== phase
      || source.trigger !== "gate post hook (auto)" || !Number.isFinite(Date.parse(source.timestamp))) {
      throw new Error("Gate issue publication entry is invalid");
    }
    if (selectedIssueLogId !== null && (typeof selectedIssueLogId !== "string"
      || selectedIssueLogId === "" || source.issueLogId !== selectedIssueLogId)) {
      throw new Error("Gate issue publication must preserve its selected canonical issue identity");
    }
    delete source.issueLogId;
    const issueLogId = selectedIssueLogId ?? `${nodeId}-result-${createHash("sha256").update(stableJson({
      runId: binding.runId,
      specId: binding.specId,
      attempt: { id: binding.attempt.id, sequence: binding.attempt.sequence },
      entry: source,
    })).digest("hex")}`;
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      ...(nodeId === binding.stepId ? {} : { nodeId }),
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
      && (binding?.nodeId ?? binding?.stepId) === (this.binding.nodeId ?? this.binding.stepId)
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

/** Exact prospective Task or integration issue, sharing the canonical Gate issue protocol. */
export class ImplementationGateIssuePublication extends GateIssuePublication {
  constructor({ binding, entry, facts = null } = {}) {
    if (binding?.stepId === "impl-gate") {
      if (entry?.phase !== "integration" || entry.taskId != null) throw new Error("Implementation Gate issue scope is invalid");
      super({ binding, entry, phase: "integration", stepId: "impl-gate" });
      return;
    }
    const identity = binding?.taskIdentity;
    if (binding?.stepId !== "task-gate" || !(identity instanceof TaskStepIdentity)
      || identity.definitionId !== "task-gate" || !identity.matchesNode(binding.nodeId)
      || entry?.phase !== "task-impl" || entry.taskId !== identity.taskId
      || !(facts instanceof GateTransitionFacts) || facts.scope !== "task"
      || facts.target.taskId !== identity.taskId || facts.target.stepId !== binding.nodeId
      || facts.target.attempt.id !== binding.attempt.id || facts.target.attempt.sequence !== binding.attempt.sequence) {
      throw new Error("Task Gate issue requires its exact prospective scope and Attempt");
    }
    const issueLogId = taskGateSettlementIssueLogId({ runId: binding.runId, nodeId: binding.nodeId,
      attempt: facts.currentAttempt, publicationActivityId: facts.catalogPublication.producerActivityId,
      catalogFingerprint: facts.catalogPublication.fingerprint });
    if (entry.issueLogId !== issueLogId) throw new Error("Task Gate issue identity does not match its canonical producer");
    super({ binding, entry, phase: "task-impl", stepId: "task-gate", issueLogId });
  }
}
