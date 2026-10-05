/** Definition-owned Task execution-round policy and recovery facts. */

const MAXIMUM_ROUNDS = 2;

function positive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

export class TaskExecutionRoundPolicy {
  constructor({ maximumRounds = MAXIMUM_ROUNDS } = {}) {
    if (maximumRounds !== MAXIMUM_ROUNDS) throw new Error(`Task execution maximumRounds must be ${MAXIMUM_ROUNDS}`);
    this.maximumRounds = MAXIMUM_ROUNDS;
    Object.freeze(this);
  }

  assertRound(round) {
    positive(round, "Task execution round");
    if (round > this.maximumRounds) throw new Error(`Task execution round exceeds the ${this.maximumRounds}-round contract`);
    return round;
  }

  isFinalRound(round) { return this.assertRound(round) === this.maximumRounds; }
  toJSON() { return { maximumRounds: this.maximumRounds }; }
}

export const TASK_EXECUTION_ROUND_POLICY = new TaskExecutionRoundPolicy();

/** Shared by Task source handoff and Gate transition facts. */
export class TaskExecutionBudget {
  constructor({ round, reviewAttemptSequenceAtStart, gateAttemptSequenceAtStart } = {}) {
    this.round = TASK_EXECUTION_ROUND_POLICY.assertRound(round);
    for (const [field, value] of Object.entries({ reviewAttemptSequenceAtStart, gateAttemptSequenceAtStart })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Task execution ${field} is invalid`);
    }
    this.reviewAttemptSequenceAtStart = reviewAttemptSequenceAtStart;
    this.gateAttemptSequenceAtStart = gateAttemptSequenceAtStart;
    Object.freeze(this);
  }

  get maximumRounds() { return TASK_EXECUTION_ROUND_POLICY.maximumRounds; }
  get finalRound() { return TASK_EXECUTION_ROUND_POLICY.isFinalRound(this.round); }
  toJSON() { return { round: this.round, reviewAttemptSequenceAtStart: this.reviewAttemptSequenceAtStart, gateAttemptSequenceAtStart: this.gateAttemptSequenceAtStart }; }
}

const OVERFLOW_TOKEN = Symbol("definition-task-execution-overrun");

function digest(value, field) {
  const result = text(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be a SHA-256 digest`);
  return result;
}

export class TaskExecutionOverrunPublication {
  constructor({ logicalKey, relativePath, hash, activityId } = {}) {
    this.logicalKey = text(logicalKey, "Task execution overrun publication logicalKey");
    this.relativePath = text(relativePath, "Task execution overrun publication relativePath");
    this.hash = digest(hash, "Task execution overrun publication hash");
    this.activityId = text(activityId, "Task execution overrun publication Activity id");
    Object.freeze(this);
  }

  toJSON() { return { logicalKey: this.logicalKey, relativePath: this.relativePath, hash: this.hash, activityId: this.activityId }; }
}

export class TaskExecutionOverrunWorktree {
  constructor({ headSha, worktreeHash } = {}) {
    this.headSha = text(headSha, "Task execution overrun worktree HEAD").toLowerCase();
    this.worktreeHash = digest(worktreeHash, "Task execution overrun worktree hash");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(this.headSha)) throw new Error("Task execution overrun worktree HEAD must be a Git SHA");
    Object.freeze(this);
  }

  toJSON() { return { headSha: this.headSha, worktreeHash: this.worktreeHash }; }
}

export class TaskExecutionOverrunFacts {
  constructor({ runId, specId, taskId, attempt, completedRounds, snapshotRevision, gate, issueLog, repair, sourceFingerprint, worktree } = {}) {
    this.runId = text(runId, "Task execution overrun runId");
    this.specId = text(specId, "Task execution overrun specId");
    this.taskId = text(taskId, "Task execution overrun taskId");
    if (!attempt || typeof attempt !== "object") throw new Error("Task execution overrun Attempt is required");
    this.attempt = Object.freeze({ id: text(attempt.id, "Task execution overrun Attempt id"), sequence: positive(attempt.sequence, "Task execution overrun Attempt sequence") });
    this.completedRounds = positive(completedRounds, "Task execution completed rounds");
    this.snapshotRevision = text(snapshotRevision, "Task execution overrun snapshot revision");
    if (!gate || typeof gate !== "object") throw new Error("Task execution overrun Gate provenance is required");
    this.gate = Object.freeze({
      sourceStep: text(gate.sourceStep, "Task execution overrun Gate source Step"),
      sourceArtifact: text(gate.sourceArtifact, "Task execution overrun Gate source artifact"),
      attempts: positive(gate.attempts, "Task execution overrun Gate attempts"),
      attempt: Object.freeze({
        id: text(gate.attempt?.id, "Task execution overrun Gate Attempt id"),
        sequence: positive(gate.attempt?.sequence, "Task execution overrun Gate Attempt sequence"),
      }),
      failure: Object.freeze({
        activityId: text(gate.failure?.activityId, "Task execution overrun Gate failure Activity id"),
        category: text(gate.failure?.category, "Task execution overrun Gate failure category"),
        code: text(gate.failure?.code, "Task execution overrun Gate failure code"),
      }),
      startActivityId: text(gate.startActivityId, "Task execution overrun Gate start Activity id"),
      publication: gate.publication instanceof TaskExecutionOverrunPublication
        ? gate.publication
        : new TaskExecutionOverrunPublication(gate.publication),
    });
    this.issueLog = issueLog instanceof TaskExecutionOverrunPublication
      ? issueLog
      : new TaskExecutionOverrunPublication(issueLog);
    if (!repair || typeof repair !== "object") throw new Error("Task execution overrun repair provenance is required");
    this.repair = Object.freeze({
      activityId: text(repair.activityId, "Task execution overrun repair Activity id"),
      attempt: Object.freeze({
        id: text(repair.attempt?.id, "Task execution overrun repair Attempt id"),
        sequence: positive(repair.attempt?.sequence, "Task execution overrun repair Attempt sequence"),
      }),
      recordId: text(repair.recordId, "Task execution overrun repair record id"),
      sourceIssueLogId: text(repair.sourceIssueLogId, "Task execution overrun repair source issue-log id"),
      sourceEntryDigest: digest(repair.sourceEntryDigest, "Task execution overrun repair source entry digest"),
    });
    this.sourceFingerprint = digest(sourceFingerprint, "Task execution overrun source fingerprint");
    this.worktree = worktree instanceof TaskExecutionOverrunWorktree
      ? worktree
      : new TaskExecutionOverrunWorktree(worktree);
    Object.freeze(this);
  }

  get overrun() { return this.completedRounds >= TASK_EXECUTION_ROUND_POLICY.maximumRounds; }
  matches(other) { return other instanceof TaskExecutionOverrunFacts && JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON()); }
  toJSON() {
    return {
      runId: this.runId, specId: this.specId, taskId: this.taskId,
      attempt: { ...this.attempt }, completedRounds: this.completedRounds,
      maximumRounds: TASK_EXECUTION_ROUND_POLICY.maximumRounds,
      snapshotRevision: this.snapshotRevision,
      gate: {
        ...this.gate, attempt: { ...this.gate.attempt }, failure: { ...this.gate.failure },
        publication: this.gate.publication.toJSON(),
      },
      issueLog: this.issueLog.toJSON(), repair: {
        activityId: this.repair.activityId, attempt: { ...this.repair.attempt },
        recordId: this.repair.recordId, sourceIssueLogId: this.repair.sourceIssueLogId,
        sourceEntryDigest: this.repair.sourceEntryDigest,
      }, sourceFingerprint: this.sourceFingerprint, worktree: this.worktree.toJSON(),
    };
  }
}

export class TaskExecutionOverrunDecision {
  constructor(token, facts) {
    if (token !== OVERFLOW_TOKEN || !(facts instanceof TaskExecutionOverrunFacts)) throw new Error("Task execution overrun decisions are created only by Definition");
    this.facts = facts;
    this.operation = "recover-task-execution-overrun";
    Object.freeze(this);
  }

  matches(other) { return other instanceof TaskExecutionOverrunDecision && JSON.stringify(this.facts.toJSON()) === JSON.stringify(other.facts.toJSON()); }
  toJSON() { return { operation: this.operation, facts: this.facts.toJSON() }; }
}

/** Definition selects recovery only for a real active attempt beyond its Task budget. */
export function resolveTaskExecutionOverrun(facts) {
  if (facts === null) return null;
  if (!(facts instanceof TaskExecutionOverrunFacts)) throw new Error("resolveTaskExecutionOverrun requires TaskExecutionOverrunFacts");
  return facts.overrun ? new TaskExecutionOverrunDecision(OVERFLOW_TOKEN, facts) : null;
}
