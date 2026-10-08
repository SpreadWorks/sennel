import { NonGateSourcePublication, NonGateStepFacts } from "./non-gate-transition.js";

/** Durable completion of the exact execution producer, independent of a transient diagnostic. */
export class AuthenticatedTestExecutionCompletion {
  constructor({ publication, receiptId, resultDigest, rawEvidenceFingerprint } = {}) {
    if (!(publication instanceof NonGateSourcePublication) || publication.stepId !== "test-execute"
      || typeof receiptId !== "string" || receiptId === ""
      || !/^[a-f0-9]{64}$/.test(resultDigest) || !/^[a-f0-9]{64}$/.test(rawEvidenceFingerprint)) {
      throw new TypeError("Test execution completion requires its exact publication, receipt, and fingerprints");
    }
    Object.assign(this, { publication, receiptId, resultDigest, rawEvidenceFingerprint });
    Object.freeze(this);
  }
  matches(publication, rawEvidenceFingerprint) {
    return JSON.stringify(this.publication.toJSON()) === JSON.stringify(publication.toJSON())
      && this.rawEvidenceFingerprint === rawEvidenceFingerprint;
  }
  toJSON() {
    return { publication: this.publication.toJSON(), receiptId: this.receiptId,
      resultDigest: this.resultDigest, rawEvidenceFingerprint: this.rawEvidenceFingerprint };
  }
  static fromJSON(value) {
    return new AuthenticatedTestExecutionCompletion({ ...value,
      publication: new NonGateSourcePublication(value.publication) });
  }
}

export class TestChainProcessFacts {
  constructor({ started, exitCode, signal, timedOut, spawnError } = {}) {
    if (typeof started !== "boolean") throw new Error("test-chain process.started must be boolean");
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) {
      throw new Error("test-chain process.exitCode must be a non-negative integer or null");
    }
    if (signal !== null && (typeof signal !== "string" || signal === "")) throw new Error("test-chain process.signal must be a non-empty string or null");
    if (typeof timedOut !== "boolean") throw new Error("test-chain process.timedOut must be boolean");
    if (spawnError !== null && (typeof spawnError !== "string" || spawnError === "")) throw new Error("test-chain process.spawnError must be a non-empty string or null");
    this.started = started;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof TestChainProcessFacts) return value;
    return new TestChainProcessFacts(value ?? { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null });
  }

  // A cataloged process record is an external observation. Incomplete
  // combinations cannot prove a semantic test outcome, so keep the Flow
  // externally blocked rather than allowing a producer to advance.
  get toolingFailure() {
    return !this.started
      || this.spawnError !== null
      || this.signal !== null
      || this.timedOut
      || this.exitCode === null;
  }
  toJSON() { return { started: this.started, exitCode: this.exitCode, signal: this.signal, timedOut: this.timedOut, spawnError: this.spawnError }; }
}

export class TestExecuteStepFacts extends NonGateStepFacts {
  constructor({ summary = [], regression = {}, rawAvailable = false, testSourceRevision = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", process = null } = {}) {
    if (!Array.isArray(summary) || regression === null || typeof regression !== "object" || Array.isArray(regression)) throw new Error("test-execute observations are invalid");
    if (typeof rawAvailable !== "boolean" || typeof testSourceRevision !== "string" || testSourceRevision === "" || typeof repairFingerprint !== "string" || repairFingerprint === "" || typeof rawEvidenceFingerprint !== "string" || rawEvidenceFingerprint === "" || typeof catalogDigest !== "string" || catalogDigest === "") {
      throw new Error("test-execute immutable evidence is required");
    }
    const processFacts = TestChainProcessFacts.from(process);
    const regressionProcess = regression.process == null ? null : TestChainProcessFacts.from(regression.process);
    super({ kind: "test-execute", values: { summary, regression, rawAvailable, testSourceRevision, repairFingerprint, rawEvidenceFingerprint, catalogDigest, process: processFacts.toJSON(), regressionProcess: regressionProcess?.toJSON() ?? null, toolingFailure: processFacts.toolingFailure || regressionProcess?.toolingFailure === true } });
  }

  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
  get process() { return TestChainProcessFacts.from(this.value("process")); }
  get regressionProcess() { return this.value("regressionProcess") === null ? null : TestChainProcessFacts.from(this.value("regressionProcess")); }
}

export class TestResultReviewStepFacts extends NonGateStepFacts {
  #executionCompletion;
  constructor({ executionCompletion = null, verdict, checkedItems = [], rawAvailable = false, testSourceRevision = "unavailable", sourceRepairFingerprint = "unavailable", sourceRawEvidenceFingerprint = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", toolingFailure = false } = {}) {
    if (executionCompletion !== null && !(executionCompletion instanceof AuthenticatedTestExecutionCompletion)) {
      throw new TypeError("Test Review completion requires authenticated execution evidence");
    }
    if (!["pass", "fail"].includes(verdict)) throw new Error("test-result-review verdict is invalid");
    if (typeof toolingFailure !== "boolean") throw new Error("test-result-review toolingFailure must be boolean");
    if (!Array.isArray(checkedItems) || typeof rawAvailable !== "boolean") throw new Error("test-result-review observations are invalid");
    if (checkedItems.length === 0 || checkedItems.some((item) => item?.result !== "pass" && item?.result !== "fail")) {
      throw new Error("test-result-review requires pass/fail checked observations");
    }
    if ((verdict === "fail") !== checkedItems.some((item) => item.result === "fail")) {
      throw new Error("test-result-review verdict must match its checked observations");
    }
    for (const [value, field] of [[testSourceRevision, "test source revision"], [sourceRepairFingerprint, "source repair fingerprint"], [sourceRawEvidenceFingerprint, "source raw evidence fingerprint"], [repairFingerprint, "repair fingerprint"], [rawEvidenceFingerprint, "raw evidence fingerprint"], [catalogDigest, "catalog digest"]]) {
      if (typeof value !== "string" || value === "") throw new Error(`test-result-review ${field} is required`);
    }
    super({ kind: "test-result-review", values: { verdict, checkedItems, rawAvailable, testSourceRevision, sourceRepairFingerprint, sourceRawEvidenceFingerprint, repairFingerprint, rawEvidenceFingerprint, catalogDigest, toolingFailure, ...(executionCompletion === null ? {} : { executionCompletion: executionCompletion.toJSON() }) } });
    this.#executionCompletion = executionCompletion;
  }

  get executionCompletion() { return this.#executionCompletion; }
  get verdict() { return this.value("verdict"); }
  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
}
