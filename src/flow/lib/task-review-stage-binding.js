function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Immutable identity of one canonical Task stage artifact. */
export class TaskStageArtifactReference {
  constructor({ logicalKey, digest, activityId, attemptId, sequence, payloadDigest }) {
    this.logicalKey = text(logicalKey, "Task artifact key");
    for (const [field, value] of Object.entries({ digest, payloadDigest })) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Task artifact ${field} is invalid`);
      this[field] = value;
    }
    this.activityId = text(activityId, "Task artifact Activity");
    this.attemptId = text(attemptId, "Task artifact Attempt");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Task artifact Attempt sequence is invalid");
    this.sequence = sequence;
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      digest: this.digest,
      payloadDigest: this.payloadDigest,
      activityId: this.activityId,
      attemptId: this.attemptId,
      sequence: this.sequence,
    };
  }
}

/** Common immutable binding carried by host filtering and Task repair. */
export class TaskReviewEpisodeBinding {
  constructor({ runId, specId, flowVersion, taskId, taskRound, reviewOrdinal, specDigest, contextDigest, sourceFingerprint, review, triage = null }) {
    for (const [field, value] of Object.entries({ runId, specId, taskId })) this[field] = text(value, `Task stage ${field}`);
    if (flowVersion !== 1) throw new Error("Task stage requires Flow Version 1");
    this.flowVersion = flowVersion;
    if (![1, 2].includes(taskRound) || ![1, 2, 3, 4].includes(reviewOrdinal)) throw new Error("Task stage semantic budget is invalid");
    this.taskRound = taskRound;
    this.reviewOrdinal = reviewOrdinal;
    for (const [field, value] of Object.entries({ specDigest, contextDigest, sourceFingerprint })) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Task stage ${field} is invalid`);
      this[field] = value;
    }
    this.review = review instanceof TaskStageArtifactReference ? review : new TaskStageArtifactReference(review);
    this.triage = triage === null ? null : triage instanceof TaskStageArtifactReference ? triage : new TaskStageArtifactReference(triage);
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      flowVersion: this.flowVersion,
      taskId: this.taskId,
      taskRound: this.taskRound,
      reviewOrdinal: this.reviewOrdinal,
      specDigest: this.specDigest,
      contextDigest: this.contextDigest,
      sourceFingerprint: this.sourceFingerprint,
      review: this.review.toJSON(),
      triage: this.triage?.toJSON() ?? null,
    };
  }

  matches(other, { includeTriage = true } = {}) {
    const left = this.toJSON();
    const right = other.toJSON();
    if (!includeTriage) {
      left.triage = null;
      right.triage = null;
    }
    return stable(left) === stable(right);
  }
}
