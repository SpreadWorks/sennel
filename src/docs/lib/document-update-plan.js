import path from "node:path";
import { AtomicFile } from "../../lib/atomic-file.js";

export class DocumentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentValidationError";
    this.code = "DOCUMENT_VALIDATION_FAILED";
  }
}

export class DocumentRevisionConflict extends Error {
  constructor(filePath) {
    super(`document changed before commit or rollback: ${filePath}`);
    this.name = "DocumentRevisionConflict";
    this.code = "DOCUMENT_REVISION_CONFLICT";
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
    this.#assertBytes(this.#originalBytes);
  }

  #assertBytes(expected) {
    const current = new AtomicFile(this.filePath).read(null);
    if (current == null || !current.equals(expected)) throw new DocumentRevisionConflict(this.filePath);
  }

  commit(faultInjector) {
    this.validate();
    this.assertCurrent();
    if (!this.changed) return { committed: false, path: this.filePath };
    return new AtomicFile(this.filePath, { faultInjector, commitGuard: () => this.assertCurrent() }).write(this.#proposedBytes);
  }

  rollback() {
    return new AtomicFile(this.filePath, { commitGuard: () => this.#assertBytes(this.#proposedBytes) }).write(this.#originalBytes);
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
        try {
          if (plan.commit(this.faultInjector).committed) attempted.push(plan);
        } catch (error) {
          if (error.committedToVisibleName) attempted.push(plan);
          throw error;
        }
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
