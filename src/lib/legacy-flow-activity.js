/** Explicit, migration-only reader for the pre-revision Activity wire contract.
 * Source: 374aecf787ca813e56d93a4bd7e23575b59b5c61, FlowActivity and
 * ActivityTransition. Later optional payloads did not exist in that contract;
 * absence means no such operation, never a successful Attempt or receipt.
 */
import { FlowActivity } from "../flow/lib/current-flow-state.js";

const ACTIVITY_FIELDS = [
  "id", "nodeId", "nodeKey", "attemptId", "sequence", "confirmationOrder", "type", "transition",
  "result", "timing", "failure", "provider", "model", "effort", "usage", "references", "metric", "note",
];
const TRANSITION_FIELDS = [
  "operation", "nodeId", "task", "attempt", "status", "policy", "outbox", "approval", "nonblocking",
];
const ABSENT_PAYLOADS = [
  "finalizeSteps", "gateTaskLifecycle", "stepConnectionReceipt", "taskReviewStagePlan",
  "requirementTestInitialization", "requirementTestLifecycle", "draftResumeReceipt",
];

function required(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`${label} must declare ${field}`);
  }
}

/** A source document retains historical facts before a later, owning migration
 * projects a retired Result. It never supplies omitted Attempt/result facts. */
export class LegacyFlowActivityDocument {
  constructor(value) {
    required(value, ACTIVITY_FIELDS, "historical Activity");
    required(value.transition, TRANSITION_FIELDS, "historical Activity transition");
    const transition = { ...value.transition };
    for (const field of ABSENT_PAYLOADS) if (!Object.hasOwn(transition, field)) transition[field] = null;
    if (!Object.hasOwn(transition, "approvalTasks")) transition.approvalTasks = [];
    const document = { ...value, transition };
    if (!Object.hasOwn(document, "reviewPublication")) document.reviewPublication = null;
    this.document = document;
    Object.freeze(this);
  }

  toJSON() { return structuredClone(this.document); }
}

/** Validates source presence before projecting the explicitly absent payloads.
 * Current validation is applied only to the completed output wire document. */
export class LegacyFlowActivityLedger {
  constructor(bytes) {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("historical Activity ledger is not UTF-8");
    if (text !== "" && !text.endsWith("\n")) throw new Error("historical Activity ledger must end with a newline");
    this.records = new Map();
    const projected = [];
    for (const [index, line] of (text === "" ? [] : text.slice(0, -1).split("\n")).entries()) {
      const document = new LegacyFlowActivityDocument(JSON.parse(line)).toJSON();
      const activity = FlowActivity.fromSerialized(document);
      if (activity.confirmationOrder !== index + 1 || this.records.has(activity.id)) {
        throw new Error(`historical Activity ${index + 1} has duplicate identity or noncontiguous order`);
      }
      this.records.set(activity.id, activity);
      projected.push(JSON.stringify(document));
    }
    this.bytes = Buffer.from(projected.map((line) => `${line}\n`).join(""), "utf8");
    Object.freeze(this);
  }
}
