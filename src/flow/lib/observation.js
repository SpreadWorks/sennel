import crypto from "crypto";
import { SpecRepairTarget } from "./spec-repair-operations.js";
import { SpecGateDocumentTarget } from "./spec-gate-targets.js";

const OBSERVATION_KEYS = new Set([
  "kind",
  "failureMode",
  "requirementRef",
  "where",
  "observed",
  "severity",
  "refs",
  "targets",
  "allowedTargets",
  "specRevision",
]);
const WHERE_KEYS = new Set(["file", "locator"]);
const FAILURE_MODES = new Set([
  "spec-impl-mismatch",
  "guardrail-violation",
  "process-evidence-missing",
]);
const SEVERITIES = new Set(["blocking", "advisory"]);

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertNoExtraKeys(value, allowed, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown property "${key}"`);
    }
  }
}

function normalizeWhere(where) {
  if (where == null) return null;
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw new Error("where must be null or an object");
  }
  assertNoExtraKeys(where, WHERE_KEYS, "where");
  const file = requireString(where.file, "where.file");
  const normalized = { file };
  if (where.locator != null) {
    normalized.locator = requireString(where.locator, "where.locator");
  }
  return normalized;
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) throw new Error("refs must be an array");
  return refs.map((ref, idx) => requireString(ref, `refs[${idx}]`));
}

function isDiffVerifiableProcessObservation(input) {
  const text = [
    input.requirementRef,
    input.observed,
    ...(Array.isArray(input.refs) ? input.refs : []),
  ].join(" ").toLowerCase();
  return /\bdiff\b|diff-verifiable|changed artifact|changed file|artifact|command output/.test(text);
}

function validateSeverityPolicy(input) {
  if (input.failureMode === "guardrail-violation" || input.failureMode === "spec-impl-mismatch") {
    if (input.severity !== "blocking") {
      throw new Error(`${input.failureMode} severity must be blocking`);
    }
    return;
  }
  if (input.failureMode === "process-evidence-missing") {
    const diffVerifiable = isDiffVerifiableProcessObservation(input);
    if (input.severity === "blocking" && !diffVerifiable) {
      throw new Error("process-evidence-missing is blocking only for diff-verifiable evidence");
    }
    if (input.severity === "advisory" && diffVerifiable) {
      throw new Error("diff-verifiable process-evidence-missing severity must be blocking");
    }
  }
}

export class Observation {
  constructor(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Observation input must be an object");
    }
    assertNoExtraKeys(input, OBSERVATION_KEYS, "Observation");
    if (input.kind !== "violation") throw new Error("kind must be violation");
    const failureMode = FAILURE_MODES.has(input.failureMode)
      ? input.failureMode
      : "guardrail-violation";
    if (!SEVERITIES.has(input.severity)) throw new Error(`invalid severity: ${input.severity}`);

    const normalized = {
      kind: "violation",
      failureMode,
      requirementRef: typeof input.requirementRef === "string" ? input.requirementRef.trim() : requireString(input.requirementRef, "requirementRef"),
      where: normalizeWhere(input.where),
      observed: requireString(input.observed, "observed"),
      severity: input.severity,
      refs: normalizeRefs(input.refs),
    };
    validateSeverityPolicy(normalized);

    this.kind = normalized.kind;
    this.failureMode = normalized.failureMode;
    this.requirementRef = normalized.requirementRef;
    this.where = normalized.where;
    this.observed = normalized.observed;
    this.severity = normalized.severity;
    this.refs = normalized.refs;
    if (Object.hasOwn(input, "specRevision")) {
      if (typeof input.specRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.specRevision)) {
        throw new Error("specRevision must be a canonical Spec digest");
      }
      if (!Array.isArray(input.targets) || input.targets.length === 0
        || !Array.isArray(input.allowedTargets) || input.allowedTargets.length === 0) {
        throw new Error("Spec Gate observation requires targets and allowedTargets");
      }
      this.targets = Object.freeze(input.targets.map((value) => (Object.hasOwn(value ?? {}, "document")
        ? new SpecGateDocumentTarget(value) : SpecRepairTarget.fromJSON(value, "observation target")).toJSON()));
      this.allowedTargets = Object.freeze(structuredClone(input.allowedTargets));
      this.specRevision = input.specRevision;
    } else if (Object.hasOwn(input, "targets") || Object.hasOwn(input, "allowedTargets")) {
      throw new Error("Spec Gate targets require specRevision");
    }
  }

  static fromJSON(input) {
    return new Observation(input);
  }

  static processEvidenceMissing({ requirementRef, where, observed, diffVerifiable }) {
    if (typeof diffVerifiable !== "boolean") {
      throw new Error("diffVerifiable must be a boolean");
    }
    return new Observation({
      kind: "violation",
      failureMode: "process-evidence-missing",
      requirementRef,
      where,
      observed,
      severity: diffVerifiable ? "blocking" : "advisory",
      refs: diffVerifiable && !isDiffVerifiableProcessObservation({ requirementRef, observed, refs: [] })
        ? ["process:diff-verifiable"]
        : [],
    });
  }

  toJSON() {
    return {
      kind: this.kind,
      failureMode: this.failureMode,
      requirementRef: this.requirementRef,
      where: this.where,
      observed: this.observed,
      severity: this.severity,
      refs: this.refs,
      ...(this.specRevision === undefined ? {} : {
        targets: this.targets,
        allowedTargets: this.allowedTargets,
        specRevision: this.specRevision,
      }),
    };
  }

  toMarkdown() {
    const location = this.where ? `${this.where.file}${this.where.locator ? `:${this.where.locator}` : ""}` : "n/a";
    return `- ${this.severity}: ${this.requirementRef} (${this.failureMode}) at ${location}: ${this.observed}`;
  }

  signature() {
    return crypto
      .createHash("sha256")
      .update(`${this.requirementRef}\0${this.observed.toLowerCase()}`)
      .digest("hex");
  }
}

export class Diagnosis {
  constructor({ summary = "", observations = [] } = {}) {
    this.summary = String(summary || "");
    if (!Array.isArray(observations)) throw new Error("observations must be an array");
    this.observations = observations.map((entry) => (
      entry instanceof Observation ? entry : Observation.fromJSON(entry)
    ));
  }

  static fromJSON(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Diagnosis input must be an object");
    }
    return new Diagnosis({
      summary: input.summary || "",
      observations: input.observations || [],
    });
  }

  toJSON() {
    return {
      summary: this.summary,
      observations: this.observations.map((observation) => observation.toJSON()),
    };
  }

  toMarkdown() {
    const rows = this.observations.map((observation) => observation.toMarkdown());
    return [this.summary, ...rows].filter(Boolean).join("\n");
  }
}

export class NextAction {
  constructor({ diagnosis, prescription }) {
    if (!(diagnosis instanceof Diagnosis)) {
      diagnosis = Diagnosis.fromJSON(diagnosis);
    }
    this.diagnosis = diagnosis;
    this.prescription = requireString(prescription, "prescription");
  }

  static fromJSON(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("NextAction input must be an object");
    }
    return new NextAction({
      diagnosis: Diagnosis.fromJSON(input.diagnosis),
      prescription: input.prescription,
    });
  }

  toJSON() {
    return {
      diagnosis: this.diagnosis.toJSON(),
      prescription: this.prescription,
    };
  }

  toMarkdown() {
    return [`Prescription: ${this.prescription}`, this.diagnosis.toMarkdown()].filter(Boolean).join("\n");
  }
}

function legacyWhere(entry) {
  const violation = Array.isArray(entry.violations) ? entry.violations[0] : null;
  const raw = violation?.where || entry.where || null;
  if (!raw) return null;
  return { file: String(raw) };
}

function legacyObserved(entry) {
  const violation = Array.isArray(entry.violations) ? entry.violations[0] : null;
  const value = violation?.why_violates || entry.reason || entry.guardrail_id || entry.category || "";
  const observed = String(value).trim();
  return observed || null;
}

function legacyFailureMode(entry) {
  if (typeof entry.guardrail_id === "string" && /^[RT]-?\d+/i.test(entry.guardrail_id)) {
    return "spec-impl-mismatch";
  }
  if (typeof entry.guardrail_id === "string" && entry.guardrail_id) {
    return "guardrail-violation";
  }
  return "process-evidence-missing";
}

export function legacyEvaluationsToNextAction({ evaluations = [], prescription }) {
  const observations = evaluations
    .filter((entry) => entry?.result === "fail")
    .map((entry) => {
      const failureMode = legacyFailureMode(entry);
      const observed = legacyObserved(entry);
      if (observed == null) return null;
      const requirementRef = entry.guardrail_id || entry.category || "";
      if (failureMode === "process-evidence-missing") {
        return Observation.processEvidenceMissing({
          requirementRef,
          where: legacyWhere(entry),
          observed,
          diffVerifiable: /diff|artifact|command output/i.test(observed),
        });
      }
      return new Observation({
        kind: "violation",
        failureMode,
        requirementRef,
        where: legacyWhere(entry),
        observed,
        severity: "blocking",
        refs: entry.guardrail_id ? [entry.guardrail_id] : [],
      });
    })
    .filter(Boolean);
  return new NextAction({
    diagnosis: new Diagnosis({
      summary: observations.length === 0 ? "No blocking observations." : `${observations.length} observation(s).`,
      observations,
    }),
    prescription,
  });
}
