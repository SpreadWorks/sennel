import crypto from "node:crypto";

import { TaskReviewEpisodeBinding } from "./task-review-stage-binding.js";
import { SourceTriageEffect, taskReviewHostExcludedDisposition } from "./source-triage-contract.js";
import { CurrentTaskSourceSnapshot, TaskMutationLineageSet } from "./task-mutation-lineage.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FINDINGS = 256;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function exactKeys(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has an invalid schema`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class TaskReviewFindingExclusion {
  constructor(value = {}) {
    exactKeys(value, ["findingId", "reason"], "Task Review exclusion");
    this.findingId = text(value.findingId, "Task Review exclusion findingId");
    this.reason = text(value.reason, "Task Review exclusion reason");
    Object.freeze(this);
  }

  toJSON() { return { findingId: this.findingId, reason: this.reason }; }
}

/** Host-selected exclusions bound to one canonical Task Review episode. */
export class TaskReviewHostFilter {
  constructor({ binding, attempt, catalogFingerprint, findings, exclusions } = {}) {
    this.version = 1;
    this.binding = binding instanceof TaskReviewEpisodeBinding ? binding : new TaskReviewEpisodeBinding(binding);
    exactKeys(attempt, ["id", "nodeId", "sequence"], "Task Review filter Attempt");
    this.attempt = Object.freeze({
      id: text(attempt.id, "Task Review filter Attempt id"),
      nodeId: text(attempt.nodeId, "Task Review filter Attempt nodeId"),
      sequence: attempt.sequence,
    });
    if (!Number.isSafeInteger(this.attempt.sequence) || this.attempt.sequence < 1
      || this.attempt.nodeId !== `${this.binding.taskId}-triage`) {
      throw new Error("Task Review filter Attempt is invalid");
    }
    this.catalogFingerprint = text(catalogFingerprint, "Task Review filter catalogFingerprint");
    if (!SHA256.test(this.catalogFingerprint)) throw new Error("Task Review filter catalogFingerprint is invalid");
    if (!Array.isArray(findings) || findings.length === 0 || findings.length > MAX_FINDINGS) {
      throw new Error("Task Review filter requires bounded canonical findings");
    }
    this.findings = Object.freeze(findings.map((finding) => Object.freeze(structuredClone(finding))));
    const findingIds = this.findings.map((finding) => text(finding?.findingId, "Task Review canonical findingId"));
    if (new Set(findingIds).size !== findingIds.length) throw new Error("Task Review canonical findingIds must be unique");
    if (!Array.isArray(exclusions) || exclusions.length > MAX_FINDINGS) {
      throw new Error("Task Review exclusions must be a bounded array");
    }
    this.exclusions = Object.freeze(exclusions.map((entry) => (
      entry instanceof TaskReviewFindingExclusion ? entry : new TaskReviewFindingExclusion(entry)
    )));
    const excludedIds = this.exclusions.map((entry) => entry.findingId);
    if (new Set(excludedIds).size !== excludedIds.length) throw new Error("Task Review exclusions must not duplicate findingId");
    const known = new Set(findingIds);
    const unknown = excludedIds.filter((findingId) => !known.has(findingId));
    if (unknown.length > 0) throw new Error(`Task Review exclusions contain unknown findingId: ${unknown.join(", ")}`);
    this.repairFindingIds = Object.freeze(findingIds.filter((findingId) => !excludedIds.includes(findingId)));
    this.digest = crypto.createHash("sha256").update(stable(this.unsignedJSON())).digest("hex");
    Object.freeze(this);
  }

  unsignedJSON() {
    return {
      version: this.version,
      binding: this.binding.toJSON(),
      attempt: this.attempt,
      catalogFingerprint: this.catalogFingerprint,
      exclusions: this.exclusions.map((entry) => entry.toJSON()),
      repairFindingIds: [...this.repairFindingIds],
    };
  }

  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }

  static fromStored(value, findings) {
    exactKeys(value, ["version", "binding", "attempt", "catalogFingerprint", "exclusions", "repairFindingIds", "digest"], "Task Review filter");
    if (value.version !== 1) throw new Error("Task Review filter version must be 1");
    const filter = new TaskReviewHostFilter({
      binding: value.binding,
      attempt: value.attempt,
      catalogFingerprint: value.catalogFingerprint,
      findings,
      exclusions: value.exclusions,
    });
    if (filter.digest !== value.digest || stable(filter.repairFindingIds) !== stable(value.repairFindingIds)) {
      throw new Error("Task Review filter digest or selected finding identity is invalid");
    }
    return filter;
  }

  toTriageEffect() {
    const exclusions = new Map(this.exclusions.map((entry) => [entry.findingId, entry]));
    return new SourceTriageEffect({
      version: 1,
      dispositions: this.findings.map((finding) => {
        const exclusion = exclusions.get(finding.findingId);
        return exclusion === undefined
          ? { findingKey: finding.findingKey, disposition: "apply", basis: "repair-required", rationale: "Selected for repair because the host did not exclude this canonical finding." }
          : taskReviewHostExcludedDisposition({ findingKey: finding.findingKey, disposition: "reject", basis: "host-excluded", rationale: `Host excluded this finding: ${exclusion.reason}` });
      }),
    });
  }

  static parseExclusions(value) {
    if (typeof value !== "string") throw new Error("Task Review filter requires --exclusions as a JSON array");
    let parsed;
    try { parsed = JSON.parse(value); }
    catch (cause) { throw new Error(`Task Review exclusions are not valid JSON: ${cause.message}`); }
    if (!Array.isArray(parsed)) throw new Error("Task Review exclusions must be a JSON array");
    return parsed.map((entry) => new TaskReviewFindingExclusion(entry));
  }
}

/** Rechecks the host decision under the canonical catalog transaction lock. */
export class TaskReviewHostFilterPublicationAdmission {
  constructor({ root, lineageSet, filter } = {}) {
    if (!(lineageSet instanceof TaskMutationLineageSet) || !(filter instanceof TaskReviewHostFilter)) {
      throw new Error("Task Review filter publication requires typed canonical authority");
    }
    this.root = root;
    this.lineageSet = lineageSet;
    this.filter = filter;
    Object.freeze(this);
  }

  assert(view) {
    const { filter } = this;
    const state = view.state;
    const review = view.catalog.artifacts.find((entry) => (
      entry.logicalKey === "task.review" && entry.relativePath === `steps/impl/${filter.binding.taskId}/review/result.json`
    )) ?? null;
    if (state.runId !== filter.binding.runId || state.specId !== filter.binding.specId
      || state.current?.at(-1) !== filter.attempt.nodeId
      || state.attempt?.id !== filter.attempt.id || state.attempt?.sequence !== filter.attempt.sequence
      || view.catalog.hash !== filter.catalogFingerprint
      || review?.hash !== filter.binding.review.digest
      || review?.activityId !== filter.binding.review.activityId) {
      throw new Error("Task Review filter Attempt, Review, or catalog binding changed before publication");
    }
    const source = CurrentTaskSourceSnapshot.capture({ root: this.root, lineageSet: this.lineageSet });
    if (source.fingerprint !== filter.binding.sourceFingerprint) {
      throw new Error("Task Review filter source binding changed before publication");
    }
  }
}
