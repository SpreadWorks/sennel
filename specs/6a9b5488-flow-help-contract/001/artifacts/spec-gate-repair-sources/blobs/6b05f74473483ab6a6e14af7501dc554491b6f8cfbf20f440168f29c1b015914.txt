const BASE_KEYS = Object.freeze(["runId", "lifecycle", "specId", "autoApprove"]);
const OPTIONAL_KEYS = Object.freeze([
  "issue",
  "issueBody",
  "request",
  "autoCheck",
  "autoDesired",
  "notes",
]);
const ALLOWED_KEYS = new Set([...BASE_KEYS, ...OPTIONAL_KEYS]);

function invariant(condition, message) {
  if (!condition) throw new PreparingFlowStateError(message);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value) {
  return Object.keys(value).every((key) => ALLOWED_KEYS.has(key))
    && BASE_KEYS.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value, field) {
  invariant(typeof value === "string" && value.trim() !== "", `${field} must be a non-empty string`);
  return value;
}

function note(value, index) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `notes[${index}] must be an object`);
  invariant(
    Object.keys(value).length === 3
      && Object.hasOwn(value, "text")
      && Object.hasOwn(value, "taskId")
      && Object.hasOwn(value, "ts"),
    `notes[${index}] has an invalid schema`,
  );
  nonEmptyString(value.text, `notes[${index}].text`);
  invariant(value.taskId === null, `notes[${index}].taskId must be null while preparing`);
  invariant(Number.isFinite(Date.parse(value.ts)), `notes[${index}].ts must be an ISO timestamp`);
  return deepFreeze(structuredClone(value));
}

export class PreparingFlowStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreparingFlowStateError";
    this.code = "PREPARING_FLOW_STATE_INVALID";
  }
}

/** Exact transient state persisted before a canonical Flow Version exists. */
export class PreparingFlowState {
  constructor(value) {
    invariant(value !== null && typeof value === "object" && !Array.isArray(value), "preparing flow state must be an object");
    invariant(exactKeys(value), "preparing flow state has an invalid schema");
    this.runId = nonEmptyString(value.runId, "preparing flow runId");
    invariant(value.lifecycle === "preparing", "preparing flow lifecycle must be preparing");
    invariant(value.specId === null, "preparing flow specId must be null");
    invariant(typeof value.autoApprove === "boolean", "preparing flow autoApprove must be boolean");
    this.lifecycle = "preparing";
    this.specId = null;
    this.autoApprove = value.autoApprove;

    if (Object.hasOwn(value, "issue")) {
      invariant(Number.isSafeInteger(value.issue) && value.issue > 0, "preparing flow issue must be a positive integer");
      this.issue = value.issue;
    }
    if (Object.hasOwn(value, "issueBody")) {
      invariant(Object.hasOwn(value, "issue"), "preparing flow issueBody requires an issue");
      this.issueBody = nonEmptyString(value.issueBody, "preparing flow issueBody");
    }
    if (Object.hasOwn(value, "request")) {
      this.request = nonEmptyString(value.request, "preparing flow request");
    }
    if (Object.hasOwn(value, "autoCheck")) {
      invariant(value.autoCheck !== null && typeof value.autoCheck === "object" && !Array.isArray(value.autoCheck), "preparing flow autoCheck must be an object");
      this.autoCheck = deepFreeze(structuredClone(value.autoCheck));
    }
    if (Object.hasOwn(value, "autoDesired")) {
      invariant(typeof value.autoDesired === "boolean", "preparing flow autoDesired must be boolean");
      this.autoDesired = value.autoDesired;
    }
    if (Object.hasOwn(value, "notes")) {
      invariant(Array.isArray(value.notes), "preparing flow notes must be an array");
      this.notes = Object.freeze(value.notes.map(note));
    }
    Object.freeze(this);
  }

  toJSON() {
    return structuredClone({
      runId: this.runId,
      lifecycle: this.lifecycle,
      specId: this.specId,
      autoApprove: this.autoApprove,
      ...(this.issue === undefined ? {} : { issue: this.issue }),
      ...(this.issueBody === undefined ? {} : { issueBody: this.issueBody }),
      ...(this.request === undefined ? {} : { request: this.request }),
      ...(this.autoCheck === undefined ? {} : { autoCheck: this.autoCheck }),
      ...(this.autoDesired === undefined ? {} : { autoDesired: this.autoDesired }),
      ...(this.notes === undefined ? {} : { notes: this.notes }),
    });
  }
}
