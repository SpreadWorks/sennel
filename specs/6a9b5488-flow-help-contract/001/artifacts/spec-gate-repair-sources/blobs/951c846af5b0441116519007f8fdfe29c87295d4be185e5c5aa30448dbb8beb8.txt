export class ArtifactCompletionSuccess {
  static [Symbol.hasInstance](value) {
    return Boolean(value
      && typeof value === "object"
      && value.constructor?.name === "ArtifactCompletionSuccess"
      && typeof value.artifactName === "string"
      && Object.prototype.hasOwnProperty.call(value, "artifact"));
  }

  constructor({ artifactName, artifact, issueCodes = [] } = {}) {
    if (typeof artifactName !== "string" || artifactName.length === 0) {
      throw new Error("artifactName must be a non-empty string");
    }
    this.artifactName = artifactName;
    this.artifact = artifact;
    this.issueCodes = Object.freeze([...issueCodes]);
    Object.freeze(this);
  }
}

export class ArtifactCompletionMechanicalFailure {
  static [Symbol.hasInstance](value) {
    return Boolean(value
      && typeof value === "object"
      && value.constructor?.name === "ArtifactCompletionMechanicalFailure"
      && typeof value.artifactName === "string"
      && Array.isArray(value.issues)
      && Array.isArray(value.issueCodes));
  }

  constructor({ artifactName, issues = [], issueCodes = [], artifact = null } = {}) {
    if (typeof artifactName !== "string" || artifactName.length === 0) {
      throw new Error("artifactName must be a non-empty string");
    }
    this.artifactName = artifactName;
    this.issues = Object.freeze((Array.isArray(issues) ? issues : [String(issues)]).map(String));
    this.issueCodes = Object.freeze([...new Set(issueCodes.length ? issueCodes : this.issues)]);
    this.artifact = artifact;
    Object.freeze(this);
  }
}

function parseArtifact({ rawText, artifact, artifactName }) {
  if (typeof rawText !== "string") return { ok: true, artifact };
  try {
    return { ok: true, artifact: JSON.parse(rawText) };
  } catch (err) {
    return {
      ok: false,
      failure: new ArtifactCompletionMechanicalFailure({
        artifactName,
        issues: [`${artifactName} contains invalid JSON: ${err.message}`],
        issueCodes: ["invalid-json"],
      }),
    };
  }
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (typeof value === "object") return Object.values(value).map(textOf).join(" ");
  return String(value);
}

function failureOrSuccess(artifactName, artifact, issueCodes) {
  const unique = [...new Set(issueCodes)];
  if (unique.length === 0) return new ArtifactCompletionSuccess({ artifactName, artifact });
  return new ArtifactCompletionMechanicalFailure({
    artifactName,
    artifact,
    issues: unique.map((code) => `${artifactName}: ${code}`),
    issueCodes: unique,
  });
}

export async function completeDraftArtifactChange(input = {}) {
  const parsed = parseArtifact({ ...input, artifactName: "draft.json" });
  if (!parsed.ok) return parsed.failure;
  const artifact = parsed.artifact;
  const issueCodes = [];
  const hasQuestionState = Array.isArray(artifact?.questionLedger?.questions);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || !hasQuestionState) {
    issueCodes.push("draft-schema-invalid");
    if (artifact && !hasQuestionState) issueCodes.push("draft-lifecycle-invalid");
  }
  if (artifact?.review?.verdict === "REJECTED" && !Array.isArray(artifact?.review?.triage?.applied)) {
    issueCodes.push("draft-schema-invalid", "draft-lifecycle-invalid", "review-triage-repair-audit-invalid");
  }
  if (textOf(artifact).includes("{{text}}") || textOf(artifact).includes("{{data")) {
    issueCodes.push("unresolved-marker");
  }
  if (artifact && !artifact.review && Object.prototype.hasOwnProperty.call(artifact, "unresolved")) {
    issueCodes.push("draft-static-check-invalid", "draft-repair-audit-invalid");
  }
  return failureOrSuccess("draft.json", artifact, issueCodes);
}

function taskNumber(taskId) {
  const match = String(taskId || "").match(/^T-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function completeSpecArtifactChange(input = {}) {
  const parsed = parseArtifact({ ...input, artifactName: "spec.json" });
  if (!parsed.ok) return parsed.failure;
  const artifact = parsed.artifact;
  const requireRepairAudit = input.requireRepairAudit !== false;
  const requireContent = input.requireContent !== false;
  const issueCodes = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || !Array.isArray(artifact.requirements)) {
    issueCodes.push("spec-schema-invalid");
  }
  if (requireContent && Array.isArray(artifact?.requirements) && artifact.requirements.length === 0) {
    issueCodes.push("spec-schema-invalid");
  }
  const tasks = Array.isArray(artifact?.tasks) ? artifact.tasks : [];
  for (let i = 1; i < tasks.length; i += 1) {
    const prev = taskNumber(tasks[i - 1]?.id);
    const current = taskNumber(tasks[i]?.id);
    if (prev != null && current != null && current < prev) {
      issueCodes.push("spec-schema-invalid", "task-monotonic-invalid");
      break;
    }
  }
  if (requireRepairAudit
    && (!artifact?.repairAudit || artifact.repairAudit.applied === false || Array.isArray(artifact.repairAudit?.unresolved))) {
    issueCodes.push("spec-repair-audit-invalid");
  }
  return failureOrSuccess("spec.json", artifact, issueCodes);
}
