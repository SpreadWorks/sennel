/** Typed, dependency-free value object for canonical upgrade evidence. */

export function upgradeResultFailure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export function upgradeResultSuccess(extra = {}) {
  return { ok: true, ...extra };
}

function validateUpgradeSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("summary must be an object");
  }
}

export function validateUpgradeResultArtifact(artifact) {
  try {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("upgrade-result.json must be an object");
    }
    if (artifact.version !== 1) throw new Error("version must be 1");
    if (typeof artifact.command !== "string" || artifact.command.length === 0) {
      throw new Error("command must be a non-empty string");
    }
    if (typeof artifact.dryRun !== "boolean") throw new Error("dryRun must be boolean");
    if (!Number.isInteger(artifact.exitCode)) throw new Error("exitCode must be integer");
    if (!["success-no-change", "success-updated", "failed"].includes(artifact.result)) {
      throw new Error("result must be success-no-change, success-updated, or failed");
    }
    if (artifact.result === "failed") {
      if (typeof artifact.failureReason !== "string" || artifact.failureReason.trim() === "") {
        throw new Error("failureReason is required for failed upgrade result");
      }
    } else if (artifact.failureReason != null) {
      throw new Error("failureReason must be null for successful upgrade result");
    }
    validateUpgradeSummary(artifact.summary);
    if (!Array.isArray(artifact.checkedPaths) || artifact.checkedPaths.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new Error("checkedPaths must be an array of non-empty strings");
    }
    const sortedUnique = [...new Set(artifact.checkedPaths)].sort();
    if (JSON.stringify(sortedUnique) !== JSON.stringify(artifact.checkedPaths)) {
      throw new Error("checkedPaths must be sorted and unique");
    }
    return upgradeResultSuccess({ artifact });
  } catch (err) {
    return upgradeResultFailure(err.message);
  }
}

/** Immutable, agent-visible result of one `sennel upgrade` invocation. */
export class UpgradeResultArtifact {
  constructor({ command, dryRun, exitCode, result, summary, checkedPaths } = {}) {
    if (typeof command !== "string" || command.length === 0) throw new Error("upgrade command is required");
    if (typeof dryRun !== "boolean") throw new Error("upgrade dryRun must be boolean");
    if (!Number.isInteger(exitCode)) throw new Error("upgrade exitCode must be integer");
    if (!Array.isArray(checkedPaths)) throw new Error("upgrade checkedPaths must be an array");
    this.command = command;
    this.dryRun = dryRun;
    this.exitCode = exitCode;
    this.result = result;
    this.summary = structuredClone(summary);
    this.checkedPaths = Object.freeze([...checkedPaths]);
    this.failureReason = result === "failed"
      ? String(summary?.error || `upgrade command exited with code ${exitCode}`)
      : null;
    const validation = validateUpgradeResultArtifact(this.toJSON());
    if (!validation.ok) throw new Error(`invalid upgrade result: ${validation.reason}`);
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: 1,
      command: this.command,
      dryRun: this.dryRun,
      exitCode: this.exitCode,
      result: this.result,
      summary: structuredClone(this.summary),
      failureReason: this.failureReason,
      checkedPaths: [...this.checkedPaths],
    };
  }
}
