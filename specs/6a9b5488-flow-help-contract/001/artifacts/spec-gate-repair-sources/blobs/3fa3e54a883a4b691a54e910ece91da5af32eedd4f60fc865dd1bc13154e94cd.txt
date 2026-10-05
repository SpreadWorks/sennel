/**
 * Typed Version-1 overview contribution.
 *
 * A Task implementation may extend the authoritative Spec overview, but it
 * must do so through the Version Store rather than by opening spec.json next
 * to a guessed Flow path. This value object owns the narrow additions-only
 * contract and the retry-safe projection check; the Store owns persistence.
 */

import { applyOverviewAdditions, validateAdditions } from "./overview-merge.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function copiedAdditions(value) {
  const errors = validateAdditions(value);
  if (errors.length > 0) throw new Error(`invalid additions: ${errors.join("; ")}`);
  return Object.freeze({
    modules: Object.freeze([...value.modules]),
    data_flow: Object.freeze([...value.data_flow]),
    decisions: Object.freeze([...value.decisions]),
  });
}

function contributionCounts(entries, taskId) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.added_by_task !== taskId || typeof entry.text !== "string") continue;
    counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
  }
  return counts;
}

function containsContribution(entries, requested, taskId) {
  const available = contributionCounts(entries, taskId);
  for (const text of requested) {
    const count = available.get(text) ?? 0;
    if (count === 0) return false;
    available.set(text, count - 1);
  }
  return true;
}

/** Result of preparing a typed overview update, before Store persistence. */
export class CanonicalOverviewUpdateResult {
  constructor({ taskId, applied, document }) {
    this.taskId = requiredText(taskId, "canonical overview result taskId");
    if (applied !== true && applied !== false) {
      throw new Error("canonical overview result applied must be boolean");
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("canonical overview result document must be an object");
    }
    this.applied = applied;
    this.document = Object.freeze(structuredClone(document));
    Object.freeze(this);
  }

  toJSON() {
    return { taskId: this.taskId, applied: this.applied };
  }
}

/**
 * A Task-local additions-only request. Repeating the same request is a no-op
 * once every requested contribution is present, so command recovery cannot
 * double-count a completed contribution.
 */
export class CanonicalOverviewUpdate {
  constructor({ taskId, additions } = {}) {
    this.taskId = requiredText(taskId, "canonical overview taskId");
    this.additions = copiedAdditions(additions);
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalOverviewUpdate ? value : new CanonicalOverviewUpdate(value);
  }

  assertActiveNode(nodeId) {
    const expected = `${this.taskId}-impl`;
    if (nodeId !== expected) {
      throw new Error(`canonical overview update requires active ${expected}`);
    }
  }

  applyTo(document) {
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("canonical overview update requires a Spec object");
    }
    const overview = document.overview ?? {};
    const alreadyApplied = ["modules", "data_flow", "decisions"].every((category) => (
      containsContribution(overview[category], this.additions[category], this.taskId)
    ));
    return new CanonicalOverviewUpdateResult({
      taskId: this.taskId,
      applied: !alreadyApplied,
      document: alreadyApplied
        ? document
        : applyOverviewAdditions(document, this.additions, this.taskId),
    });
  }
}
