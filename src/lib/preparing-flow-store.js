/**
 * src/lib/preparing-flow-store.js
 *
 * Manages `.sennel/.active-flow.<runId>` — transient state files
 * created during the prepare phase before flow.json exists.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { managedDir } from "./config.js";
import { AtomicFile } from "./atomic-file.js";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { PreparingFlowState } from "./preparing-flow-state.js";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import {
  PREPARING_PREFIX,
  PREPARING_SCAN_LIMIT,
} from "./flow-helpers.js";

const MAX_RUN_ID_LENGTH = 200;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class PreparingFlowId {
  constructor(value) {
    if (
      typeof value !== "string"
      || value.length > MAX_RUN_ID_LENGTH
      || !SAFE_RUN_ID.test(value)
      || value === "."
      || value === ".."
    ) {
      throw new Error("preparing flow runId must be a safe non-empty identifier");
    }
    this.value = value;
    Object.freeze(this);
  }

  toString() {
    return this.value;
  }

  lockName() {
    const digest = crypto.createHash("sha256").update(this.value).digest("hex");
    return `.preparing-flow.${digest}.lock`;
  }
}

class PreparingFlowSnapshot {
  constructor(filePath) {
    this.filePath = filePath;
    this.content = new AtomicFile(filePath).read(null);
    if (this.content == null) {
      const error = new Error(`preparing flow not found: ${path.basename(filePath)}`);
      error.code = "PREPARING_FLOW_NOT_FOUND";
      throw error;
    }
    this.revision = crypto.createHash("sha256").update(this.content).digest("hex");
    this.state = new PreparingFlowState(JSON.parse(this.content.toString("utf8"))).toJSON();
    Object.freeze(this);
  }

  assertCurrent() {
    const content = new AtomicFile(this.filePath).read(null);
    const revision = content == null
      ? null
      : crypto.createHash("sha256").update(content).digest("hex");
    if (revision !== this.revision || !content.equals(this.content)) {
      const error = new Error("preparing flow revision changed concurrently");
      error.code = "PREPARING_FLOW_REVISION_CONFLICT";
      throw error;
    }
  }
}

export class PreparingFlowStore {
  /**
   * @param {Object} opts
   * @param {string} opts.mainRoot
   */
  constructor({ mainRoot, faultInjector = () => {}, processIdentitySource } = {}) {
    this._mainRoot = path.resolve(mainRoot);
    this._faultInjector = faultInjector;
    this._processIdentitySource = processIdentitySource;
  }

  /** @returns {string} new runId */
  generateRunId() {
    return crypto.randomUUID();
  }

  /**
   * @param {string} runId
   * @param {object} [extra]
   * @returns {string} created file path
   */
  create(runId, extra = {}) {
    const id = new PreparingFlowId(runId);
    const state = {
      runId,
      lifecycle: "preparing",
      specId: null,
      autoApprove: false,
      ...extra,
    };
    if (state.runId !== runId || state.lifecycle !== "preparing" || state.specId !== null) {
      throw new Error("preparing flow state must preserve runId, preparing lifecycle, and null specId");
    }
    const p = this.#path(id);
    return this.#withLock(id, () => {
      if (fs.existsSync(p)) {
        const error = new Error(`preparing flow already exists: ${id}`);
        error.code = "PREPARING_FLOW_ALREADY_EXISTS";
        throw error;
      }
      const validState = new PreparingFlowState(state).toJSON();
      new AtomicJsonFile(p, { faultInjector: this._faultInjector }).write(validState);
      return p;
    });
  }

  /**
   * @param {string} runId
   * @returns {object|null}
   */
  load(runId) {
    const id = new PreparingFlowId(runId);
    const p = this.#path(id);
    if (!fs.existsSync(p)) return null;
    try {
      return new PreparingFlowSnapshot(p).state;
    } catch (cause) {
      const error = new Error(`preparing flow is corrupt: ${runId}`, { cause });
      error.code = "PREPARING_FLOW_CORRUPT";
      throw error;
    }
  }

  /**
   * Resolve { issue, request } from CLI args and a preparing-flow file.
   * CLI values take precedence; empty CLI values fall back to preparing values.
   *
   * @param {string} runId - runId from --run-id, or empty when absent
   * @param {string} cliIssue
   * @param {string} cliRequest
   * @returns {{ issue: string, request: string }}
   */
  resolveInputs(runId, cliIssue, cliRequest) {
    let issue = cliIssue || "";
    let request = cliRequest || "";
    if (!runId) return { issue, request };

    const preparing = this.load(runId);
    if (!preparing) {
      throw new Error(`preparing flow not found for runId: ${runId}`);
    }
    if (!issue && preparing.issue != null) issue = String(preparing.issue);
    if (!request && preparing.request) request = preparing.request;
    return { issue, request };
  }

  /**
   * Mutate a preparing flow state by runId. Loads the file, applies the
   * mutator, and writes it back atomically.
   *
   * @param {string} runId
   * @param {(state: object) => void} mutator
   * @returns {object} the updated state
   */
  mutate(runId, mutator) {
    const id = new PreparingFlowId(runId);
    const p = this.#path(id);
    return this.#withLock(id, () => {
      const snapshot = new PreparingFlowSnapshot(p);
      const state = structuredClone(snapshot.state);
      mutator(state);
      if (state.runId !== runId || state.lifecycle !== "preparing" || state.specId !== null) {
        throw new Error("preparing flow mutation must preserve runId, preparing lifecycle, and null specId");
      }
      const validState = new PreparingFlowState(state).toJSON();
      snapshot.assertCurrent();
      new AtomicJsonFile(p, { faultInjector: this._faultInjector }).write(validState);
      return validState;
    });
  }

  /** @param {string} runId */
  delete(runId) {
    const id = new PreparingFlowId(runId);
    const p = this.#path(id);
    if (!fs.existsSync(managedDir(this._mainRoot))) return;
    this.#withLock(id, () => {
      new AtomicFile(p, { faultInjector: this._faultInjector }).remove();
    });
  }

  /** @returns {string[]} runIds */
  list() {
    const dir = managedDir(this._mainRoot);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(PREPARING_PREFIX))
      .map((f) => f.slice(PREPARING_PREFIX.length))
      .slice(0, PREPARING_SCAN_LIMIT);
  }

  #path(id) {
    return path.join(managedDir(this._mainRoot), `${PREPARING_PREFIX}${id}`);
  }

  #withLock(id, body) {
    const rootAuthority = new RealDirectoryAuthority(this._mainRoot);
    const directoryAuthority = new RealDirectoryAuthority(managedDir(this._mainRoot), {
      create: true,
      parentAuthority: rootAuthority,
    });
    const errorFactory = (status, message, { lockPath, cause } = {}) => {
      const error = new Error(message, { cause });
      error.code = status === "live" || status === "timeout"
        ? "PREPARING_FLOW_BUSY"
        : `PREPARING_FLOW_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
      error.lockPath = lockPath;
      return error;
    };
    const lock = new FileLock({
      directoryAuthority,
      fileName: id.lockName(),
      kind: "preparing-flow",
      authority: { mainRoot: this._mainRoot, runId: id.toString(), path: this.#path(id) },
      ...(this._processIdentitySource && { processIdentitySource: this._processIdentitySource }),
      errorFactory,
    });
    return lock.runExclusive(body);
  }

}
