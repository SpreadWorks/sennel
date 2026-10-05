import path from "node:path";
import { AtomicFile } from "../../lib/atomic-file.js";

export class DocumentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentValidationError";
    this.code = "DOCUMENT_VALIDATION_FAILED";
  }
}

export class DocumentValidationResult {
  constructor(ok, reason = null) {
    if (typeof ok !== "boolean") throw new Error("document validation status must be boolean");
    if (!ok && (typeof reason !== "string" || reason.trim() === "")) {
      throw new Error("rejected document validation requires a reason");
    }
    this.ok = ok;
    this.reason = reason;
    Object.freeze(this);
  }

  static accepted() {
    return new DocumentValidationResult(true);
  }

  static rejected(reason) {
    return new DocumentValidationResult(false, reason);
  }

  throwIfInvalid(filePath) {
    if (!this.ok) throw new DocumentValidationError(`${filePath}: ${this.reason}`);
  }
}

export class DocumentUpdatePlan {
  #originalBytes;
  #proposedBytes;

  constructor({ filePath, originalBytes, proposedBytes, validationResult }) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("document update filePath is required");
    }
    if (!Buffer.isBuffer(originalBytes) || !Buffer.isBuffer(proposedBytes)) {
      throw new Error("document update bytes must be Buffers");
    }
    if (!(validationResult instanceof DocumentValidationResult)) {
      throw new Error("document update validationResult is required");
    }
    this.filePath = path.resolve(filePath);
    this.#originalBytes = Buffer.from(originalBytes);
    this.#proposedBytes = Buffer.from(proposedBytes);
    this.validationResult = validationResult;
    Object.freeze(this);
  }

  get originalBytes() {
    return Buffer.from(this.#originalBytes);
  }

  get proposedBytes() {
    return Buffer.from(this.#proposedBytes);
  }

  get changed() {
    return !this.#originalBytes.equals(this.#proposedBytes);
  }

  validate() {
    this.validationResult.throwIfInvalid(this.filePath);
    return this;
  }

  assertCurrent() {
    const current = new AtomicFile(this.filePath).read(null);
    if (current == null || !current.equals(this.#originalBytes)) {
      const error = new Error(`document changed before commit: ${this.filePath}`);
      error.code = "DOCUMENT_REVISION_CONFLICT";
      throw error;
    }
  }

  commit(faultInjector) {
    this.validate();
    this.assertCurrent();
    if (!this.changed) return { committed: false, path: this.filePath };
    return new AtomicFile(this.filePath, { faultInjector }).write(this.#proposedBytes);
  }

  rollback() {
    return new AtomicFile(this.filePath).write(this.#originalBytes);
  }
}

export class DocumentUpdateTransaction {
  constructor(plans, { faultInjector = () => {} } = {}) {
    if (!Array.isArray(plans) || plans.some((plan) => !(plan instanceof DocumentUpdatePlan))) {
      throw new Error("document update transaction requires DocumentUpdatePlan entries");
    }
    this.plans = Object.freeze([...plans]);
    this.faultInjector = faultInjector;
    Object.freeze(this);
  }

  commit() {
    for (const plan of this.plans) plan.validate();
    for (const plan of this.plans) plan.assertCurrent();

    const attempted = [];
    try {
      for (const plan of this.plans) {
        if (!plan.changed) continue;
        attempted.push(plan);
        plan.commit(this.faultInjector);
      }
    } catch (primaryError) {
      const rollbackErrors = [];
      for (const plan of attempted.reverse()) {
        try {
          plan.rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...rollbackErrors],
          "document transaction commit and rollback both failed",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
    return this.plans.filter((plan) => plan.changed).map((plan) => plan.filePath);
  }
}
