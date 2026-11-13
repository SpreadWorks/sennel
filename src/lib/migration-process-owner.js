import crypto from "node:crypto";
import { LockOwnerSession } from "./process-lock.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";

const ACTIVE_MIGRATION_OWNER_TOKENS = new Set();
const MIGRATION_OWNER_SESSION = LockOwnerSession.current().ownerSession;

export class MigrationProcessOwner extends LockOwnerSession {
  constructor({ ownerToken, ownerSession, released = false }) {
    super({ ownerToken, ownerSession });
    if (typeof released !== "boolean") throw new TypeError("migration journal owner release must be boolean");
    this.released = released;
    Object.freeze(this);
  }
  static current() {
    return new MigrationProcessOwner({ ownerToken: crypto.randomUUID(), ownerSession: MIGRATION_OWNER_SESSION });
  }
  static fromJSON(value) {
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(["ownerSession", "ownerToken", "released"])) {
      throw new ProcessExecutionControlFailure("legacy-owner-format", "Migration journal requires a token/session owner and explicit writer release; PID owners cannot authorize recovery");
    }
    return new MigrationProcessOwner(value);
  }
  activate() {
    if (this.ownerSession !== MIGRATION_OWNER_SESSION || this.released || ACTIVE_MIGRATION_OWNER_TOKENS.has(this.ownerToken)) {
      throw new Error("migration journal process owner cannot be activated");
    }
    ACTIVE_MIGRATION_OWNER_TOKENS.add(this.ownerToken);
  }
  assertActive() {
    if (this.released || this.ownerSession !== MIGRATION_OWNER_SESSION || !ACTIVE_MIGRATION_OWNER_TOKENS.has(this.ownerToken)) {
      throw new ProcessExecutionControlFailure("owner-unknown", "Migration publication requires its current active writer session");
    }
  }
  release() {
    if (this.ownerSession !== MIGRATION_OWNER_SESSION) throw new Error("cannot release a foreign migration writer");
    ACTIVE_MIGRATION_OWNER_TOKENS.delete(this.ownerToken);
    return new MigrationProcessOwner({ ...super.toJSON(), released: true });
  }
  assertInactive() {
    if (this.ownerSession === MIGRATION_OWNER_SESSION && ACTIVE_MIGRATION_OWNER_TOKENS.has(this.ownerToken)) {
      throw new ProcessExecutionControlFailure("owner-busy", "Migration journal belongs to an active writer session");
    }
    if (this.released) return;
    throw new ProcessExecutionControlFailure("owner-unknown", "Migration journal has no explicit writer release; process disappearance cannot authorize recovery");
  }
  toJSON() { return { ...super.toJSON(), released: this.released }; }
}
