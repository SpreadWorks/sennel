import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ArtifactAuthority, ArtifactAuthoritySlot, ArtifactCardinality } from "./artifact-authority.js";
import { FLOW_ARTIFACT_AUTHORITY_MATRIX } from "../flow/lib/flow-artifact-authority.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROOT_ARTIFACT_KEYS = new Set([
  "flow.state", "flow.activities", "spec.record", "issue.log", "artifact.catalog", "issue.snapshot",
]);
const RETENTIONS = new Set(["permanent", "transient"]);
const PLACEMENT_CATEGORIES = new Set(["root-authority", "revision-authority", "step-owner", "step-shared", "independent-deliverable", "transient"]);
const MUTATION_POLICIES = new Set(["replaceable", "immutable"]);
const SWITCH_TARGET_ACTIONS = new Set(["switch", "new", "remove"]);
const INVENTORY_EXCLUSION_CATEGORIES = new Set(["user-deliverable", "historical-temporary"]);
const AUTHORITY_ACTORS = new Set(["system", ...FLOW_ARTIFACT_AUTHORITY_MATRIX.map((entry) => entry.stepId)]);
export const FINAL_REGRESSION_MAX_ATTEMPTS = 10_000;

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function identifier(value, field) {
  const result = requiredText(value, field);
  if (!IDENTIFIER.test(result)) throw new Error(`${field} must be an identifier`);
  return result;
}

function safeRelativePath(value, field) {
  const result = requiredText(value, field);
  if (result.includes("\\") || path.posix.isAbsolute(result) || path.posix.normalize(result) !== result) {
    throw new Error(`${field} must be a normalized POSIX relative path`);
  }
  if (result.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must not contain empty, current, or parent segments`);
  }
  return result;
}

class FlowArtifactRelativePath {
  constructor(value, field) {
    this.value = safeRelativePath(value, field);
    Object.freeze(this);
  }
  static from(value, field) {
    return value instanceof FlowArtifactRelativePath ? value : new FlowArtifactRelativePath(value, field);
  }
  toString() { return this.value; }
}

function people(values, field) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${field} must name at least one actor`);
  const normalized = values.map((value) => identifier(value, field));
  if (normalized.some((value) => !AUTHORITY_ACTORS.has(value))) throw new Error(`${field} must name an authority step or system actor`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze(normalized);
}

function authorityActor(value, field) {
  const actor = identifier(value, field);
  if (!AUTHORITY_ACTORS.has(actor)) throw new Error(`${field} must name an authority step or system actor`);
  return actor;
}

/** Normalizes static and task-local Activity node identities to artifact authority actors. */
export class FlowArtifactUpdater {
  constructor(value) {
    this.value = authorityActor(value, "artifact updater");
    Object.freeze(this);
  }
  static fromActivityNodeId(value) {
    const nodeId = requiredText(value, "Flow Activity nodeId");
    // Flow lifecycle Activities are system-coordinated records.  They still
    // carry the immutable root node id in the ledger, while publication uses
    // the only root-authority actor permitted to update flow.json itself.
    if (nodeId === "flow" || nodeId === "impl") return new FlowArtifactUpdater("system");
    if (AUTHORITY_ACTORS.has(nodeId)) return new FlowArtifactUpdater(nodeId);
    const taskStep = nodeId.match(/^.+-(impl|review|triage|repair|gate)$/)?.[1] ?? null;
    if (taskStep !== null) return new FlowArtifactUpdater(`task-${taskStep}`);
    throw new Error(`Flow Activity nodeId has no artifact updater actor: ${nodeId}`);
  }
  toString() { return this.value; }
}

function immutableData(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const member of Object.values(value)) immutableData(member, seen);
  return Object.freeze(value);
}

export class FlowArtifactLogicalKey {
  constructor(value) {
    this.value = requiredText(value, "artifact logical key");
    if (!this.value.split(".").every((part) => IDENTIFIER.test(part))) {
      throw new Error("artifact logical key must contain dot-separated identifiers");
    }
    Object.freeze(this);
  }
  toString() { return this.value; }
}

export class FlowArtifactRetention {
  constructor(value) {
    this.value = identifier(value, "artifact retention");
    if (!RETENTIONS.has(this.value)) throw new Error(`unknown artifact retention: ${this.value}`);
    Object.freeze(this);
  }
  toString() { return this.value; }
}

/** Governs whether a cataloged canonical artifact can replace prior bytes. */
export class FlowArtifactMutationPolicy {
  constructor(value) {
    this.value = identifier(value, "artifact mutation policy");
    if (!MUTATION_POLICIES.has(this.value)) throw new Error(`unknown artifact mutation policy: ${this.value}`);
    Object.freeze(this);
  }
  assertPublication(previous, next) {
    if (this.value === "immutable" && previous !== undefined && previous !== null
      && (previous.hash !== next.hash || previous.size !== next.size)) {
      throw new Error("immutable artifact publication cannot replace existing bytes");
    }
  }
  toString() { return this.value; }
}

/** Declares why an artifact lives at its canonical path. */
export class FlowArtifactPlacement {
  constructor(value) {
    this.value = identifier(value, "artifact placement");
    if (!PLACEMENT_CATEGORIES.has(this.value)) throw new Error(`unknown artifact placement: ${this.value}`);
    Object.freeze(this);
  }
  assertCompatible({ logicalKey, canonicalPath, retention, cataloged } = {}) {
    const key = new FlowArtifactLogicalKey(logicalKey).toString();
    const target = canonicalPath instanceof FlowArtifactCanonicalPath ? canonicalPath.toString() : new FlowArtifactCanonicalPath(canonicalPath).toString();
    const lifetime = retention instanceof FlowArtifactRetention ? retention.toString() : new FlowArtifactRetention(retention).toString();
    if (this.value === "root-authority") {
      if (!ROOT_ARTIFACT_KEYS.has(key) || target.includes("/") || lifetime !== "permanent") {
        throw new Error("root authority placement requires one of the six permanent root artifacts");
      }
      if (cataloged !== (key !== "artifact.catalog")) throw new Error("root authority catalog membership must match the catalog self-exception");
      return;
    } else if (this.value === "revision-authority") {
      if (!new Set(["spec.snapshot", "spec.review"]).has(key)
        || !target.startsWith("revisions/:{revision}/") || lifetime !== "permanent" || cataloged !== true) {
        throw new Error("revision authority placement requires a cataloged permanent revisions/:{revision}/ artifact");
      }
      return;
    }
    if (this.value === "independent-deliverable") {
      if (!target.startsWith("artifacts/") || lifetime !== "permanent" || cataloged !== true) {
        throw new Error("independent deliverable placement requires a cataloged permanent artifacts/ path");
      }
      return;
    }
    if (this.value === "transient") {
      const stepLog = /^steps\/(?:scenario-validity|test-execute)\/output\.log$/.test(target)
        || /^steps\/final-regression\/attempt-:\{attempt\}\.log$/.test(target);
      if ((!target.startsWith(".runtime/") && !stepLog) || lifetime !== "transient" || cataloged !== false) {
        throw new Error("transient placement requires a non-cataloged transient runtime or step log path");
      }
      return;
    }
    if (!target.startsWith("steps/") || lifetime !== "permanent" || cataloged !== true) {
      throw new Error(`${this.value} placement requires a cataloged permanent steps/ path`);
    }
    const segments = target.split("/");
    if (this.value === "step-shared" && (segments.length !== 2 || segments[0] !== "steps" || target.includes(":{"))) {
      throw new Error("step shared placement requires one static file directly below steps/");
    }
    if (this.value === "step-owner" && (segments.length < 3 || segments[0] !== "steps")) {
      throw new Error("step owner placement requires a steps/<owner>/<file> hierarchy");
    }
  }
  toString() { return this.value; }
}

export class FlowArtifactAttempt {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("artifact attempt must be a positive safe integer");
    this.value = value;
    Object.freeze(this);
  }
  toString() { return String(this.value).padStart(3, "0"); }
}

export class FlowArtifactAttemptSequence {
  constructor(attempts = []) {
    if (!Array.isArray(attempts) || attempts.some((attempt) => !(attempt instanceof FlowArtifactAttempt))) {
      throw new Error("artifact attempt sequence requires typed attempts");
    }
    for (let index = 1; index < attempts.length; index += 1) {
      if (attempts[index - 1].value >= attempts[index].value) throw new Error("artifact attempts must be append-only and strictly increasing");
    }
    this.attempts = Object.freeze([...attempts]);
    Object.freeze(this);
  }
  next() { return new FlowArtifactAttempt((this.attempts.at(-1)?.value ?? 0) + 1); }
}

export class FlowArtifactAttemptHistory {
  constructor(attempts = []) {
    if (!Array.isArray(attempts) || attempts.some((attempt) => !(attempt instanceof FlowArtifactAttemptRecord))) throw new Error("artifact attempt history requires typed attempt records");
    this.sequence = new FlowArtifactAttemptSequence(attempts.map((record) => record.attempt));
    this.attempts = Object.freeze([...attempts]);
    this.current = attempts.at(-1) ?? null;
    Object.freeze(this);
  }
  static fromJSON(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.attempts)) {
      throw new Error("artifact attempt history must contain an attempts array");
    }
    for (const duplicate of ["current", "latest", "currentJudgment", "latestResult", "verdict", "result"]) {
      if (Object.hasOwn(value, duplicate)) throw new Error(`artifact attempt history must derive ${duplicate} from its last attempt`);
    }
    return new FlowArtifactAttemptHistory(value.attempts.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("artifact attempt history entries must be objects");
      }
      const { attempt, ...payload } = entry;
      return new FlowArtifactAttemptRecord({ attempt, payload });
    }));
  }
  append(record) { return new FlowArtifactAttemptHistory([...this.attempts, record]); }
  assertExtends(previous) {
    if (!(previous instanceof FlowArtifactAttemptHistory)) throw new Error("previous artifact attempt history is required");
    if (this.attempts.length < previous.attempts.length) throw new Error("artifact attempt history must be append-only");
    for (let index = 0; index < previous.attempts.length; index += 1) {
      if (!isDeepStrictEqual(this.attempts[index].toJSON(), previous.attempts[index].toJSON())) {
        throw new Error("artifact attempt history must preserve its prior prefix");
      }
    }
    return this;
  }
  toJSON() { return { attempts: this.attempts.map((record) => record.toJSON()) }; }
}

export class FlowArtifactAttemptRecord {
  constructor({ attempt, payload } = {}) {
    this.attempt = attempt instanceof FlowArtifactAttempt ? attempt : new FlowArtifactAttempt(attempt);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("artifact attempt payload must be an object");
    if (Object.hasOwn(payload, "attempt")) throw new Error("artifact attempt payload must not override attempt");
    this.payload = immutableData(structuredClone(payload));
    Object.freeze(this);
  }
  toJSON() { return { attempt: this.attempt.value, ...this.payload }; }
}

export class FlowArtifactContentContract {
  parse() { throw new Error("artifact content contract must implement parse"); }
  assertPublication() { throw new Error("artifact content contract must implement assertPublication"); }
  /**
   * Some immutable artifacts bind their bytes to the Activity that published
   * them.  The catalog calls this after it has resolved the ledger entry.
   * Most content formats deliberately have no such coupling.
   */
  assertCatalogAssociation() { return null; }
}

/** Parses and compares the durable JSON shape shared by retried result artifacts. */
export class FlowArtifactAttemptHistoryContent extends FlowArtifactContentContract {
  constructor() { super(); Object.freeze(this); }
  parse(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("artifact attempt history content must be a Buffer");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
      throw new Error(`artifact attempt history must be valid JSON: ${error.message}`);
    }
    return FlowArtifactAttemptHistory.fromJSON(value);
  }
  assertPublication(previousBytes, nextBytes) {
    const next = this.parse(nextBytes);
    if (next.current === null) throw new Error("artifact attempt history must contain at least one attempt");
    if (previousBytes !== null) next.assertExtends(this.parse(previousBytes));
    return next;
  }
}

export class FlowArtifactLegacyTarget {
  constructor(value) { this.value = safeRelativePath(value, "legacy artifact target"); Object.freeze(this); }
  toString() { return this.value; }
}

export class FlowArtifactSwitchTarget {
  constructor({ logicalKey, legacyPaths = [], legacyPatterns = [], canonicalPath = null, action, producer, consumer } = {}) {
    this.logicalKey = new FlowArtifactLogicalKey(logicalKey).toString();
    if (!Array.isArray(legacyPaths)) throw new Error("switch target legacy paths must be an array");
    if (!Array.isArray(legacyPatterns)) throw new Error("switch target legacy patterns must be an array");
    this.legacyPaths = Object.freeze(legacyPaths.map((value) => new FlowArtifactLegacyTarget(value)));
    this.legacyPatterns = Object.freeze(legacyPatterns.map((value) => (
      value instanceof FlowArtifactLegacyPattern ? value : new FlowArtifactLegacyPattern(value)
    )));
    const legacyValues = [...this.legacyPaths, ...this.legacyPatterns].map(String);
    if (new Set(legacyValues).size !== legacyValues.length) throw new Error("switch target legacy paths must not contain duplicates");
    this.action = identifier(action, "switch target action");
    if (!SWITCH_TARGET_ACTIONS.has(this.action)) throw new Error("switch target action is invalid");
    if (this.action === "new") {
      if (legacyValues.length !== 0) throw new Error("new artifact target must not declare legacy paths");
      this.canonicalPath = new FlowArtifactCanonicalPath(canonicalPath).toString();
    } else if (this.action === "switch") {
      if (legacyValues.length === 0) throw new Error("switch target requires legacy paths");
      this.canonicalPath = new FlowArtifactCanonicalPath(canonicalPath).toString();
    } else {
      if (legacyValues.length === 0) throw new Error("remove target requires legacy paths");
      if (canonicalPath !== null) throw new Error("remove target must not declare a canonical path");
      this.canonicalPath = null;
    }
    this.producer = authorityActor(producer, "switch target producer");
    this.consumer = authorityActor(consumer, "switch target consumer");
    Object.freeze(this);
  }

  matchesLegacyPath(value) {
    const relativePath = safeRelativePath(value, "legacy artifact target");
    return this.legacyPaths.some((target) => target.toString() === relativePath)
      || this.legacyPatterns.some((pattern) => pattern.matches(relativePath));
  }
}

export class FlowArtifactNoArtifactClassification {
  constructor(stepId, reason) { this.stepId = identifier(stepId, "no-artifact step"); this.reason = requiredText(reason, "no-artifact reason"); Object.freeze(this); }
}

/** Repository-specific tracked files proven not to be current normal-Flow switch targets. */
export class FlowArtifactInventoryExclusion {
  constructor({ relativePath, category, reason } = {}) {
    this.relativePath = safeRelativePath(relativePath, "artifact inventory exclusion path");
    this.category = identifier(category, "artifact inventory exclusion category");
    if (!INVENTORY_EXCLUSION_CATEGORIES.has(this.category)) throw new Error("artifact inventory exclusion category is invalid");
    this.reason = requiredText(reason, "artifact inventory exclusion reason");
    Object.freeze(this);
  }
  toString() { return this.relativePath; }
}

export class FlowArtifactCanonicalPath {
  #matchExpression;

  constructor(value) {
    this.value = safeRelativePath(value, "artifact canonical path");
    this.parameters = Object.freeze([...this.value.matchAll(/:\{([A-Za-z0-9][A-Za-z0-9._-]*)\}/g)].map((match) => match[1]));
    if (new Set(this.parameters).size !== this.parameters.length) throw new Error("artifact canonical path must not repeat a parameter");
    this.#matchExpression = new RegExp(`^${this.#matchSource()}$`);
    Object.freeze(this);
  }
  resolve(parameters = {}) {
    const supplied = Object.keys(parameters).sort();
    const expected = [...this.parameters].sort();
    if (supplied.length !== expected.length || supplied.some((key, index) => key !== expected[index])) {
      throw new Error(`artifact path parameters must be exactly: ${expected.join(", ") || "none"}`);
    }
    let resolved = this.value;
    for (const parameter of this.parameters) {
      const value = parameter.endsWith("Path")
        ? safeRelativePath(parameters[parameter], `artifact path parameter ${parameter}`)
        : identifier(parameters[parameter], `artifact path parameter ${parameter}`);
      resolved = resolved.replace(`:{${parameter}}`, value);
    }
    return safeRelativePath(resolved, "resolved artifact canonical path");
  }
  matches(value) {
    const candidate = FlowArtifactRelativePath.from(value, "artifact path").toString();
    return this.#matchExpression.test(candidate);
  }
  #matchSource() {
    const expression = this.value.split("/").map((segment) => {
      const parameterPattern = /:\{([A-Za-z0-9][A-Za-z0-9._-]*)\}/g;
      let result = "";
      let cursor = 0;
      let match;
      while ((match = parameterPattern.exec(segment)) !== null) {
        result += segment.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result += match[1].endsWith("Path") && match[0] === segment ? ".+" : "[A-Za-z0-9][A-Za-z0-9._-]*";
        cursor = match.index + match[0].length;
      }
      return result + segment.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return expression;
  }
  toString() { return this.value; }
}

/** A typed, optionally constrained source-era path pattern. */
export class FlowArtifactLegacyPattern {
  constructor(value, { excludedPrefixes = [] } = {}) {
    this.path = value instanceof FlowArtifactCanonicalPath ? value : new FlowArtifactCanonicalPath(value);
    if (!Array.isArray(excludedPrefixes)) throw new Error("legacy artifact pattern excluded prefixes must be an array");
    this.excludedPrefixes = Object.freeze(excludedPrefixes.map((prefix) => {
      const hasTrailingSlash = typeof prefix === "string" && prefix.endsWith("/");
      const normalized = safeRelativePath(hasTrailingSlash ? prefix.slice(0, -1) : prefix, "legacy artifact pattern excluded prefix");
      return hasTrailingSlash ? `${normalized}/` : normalized;
    }));
    Object.freeze(this);
  }
  matches(value) {
    const candidatePath = FlowArtifactRelativePath.from(value, "legacy artifact path");
    const candidate = candidatePath.toString();
    return this.path.matches(candidatePath) && !this.excludedPrefixes.some((prefix) => (
      candidate === prefix.slice(0, -1) || candidate.startsWith(prefix)
    ));
  }
  toString() { return this.path.toString(); }
}

/** One source-era filename or pattern in the normal Flow inventory. */
export class FlowArtifactKnownFile {
  constructor({ logicalKey, action, legacyPath = null, legacyPattern = null, canonicalPath = null } = {}) {
    this.logicalKey = new FlowArtifactLogicalKey(logicalKey).toString();
    this.action = identifier(action, "known Flow artifact action");
    if (!SWITCH_TARGET_ACTIONS.has(this.action)) throw new Error("known Flow artifact action is invalid");
    if (this.action === "new") {
      if (legacyPath !== null || legacyPattern !== null || canonicalPath === null) {
        throw new Error("new known Flow artifact requires exactly one canonical path");
      }
      this.legacyPath = null;
      this.legacyPattern = null;
      this.canonicalPath = canonicalPath instanceof FlowArtifactCanonicalPath
        ? canonicalPath : new FlowArtifactCanonicalPath(canonicalPath);
    } else {
      if (canonicalPath !== null || (legacyPath === null) === (legacyPattern === null)) {
        throw new Error("known Flow artifact requires exactly one legacy path or pattern");
      }
      this.legacyPath = legacyPath === null ? null : new FlowArtifactLegacyTarget(legacyPath);
      this.legacyPattern = legacyPattern === null ? null : (
        legacyPattern instanceof FlowArtifactLegacyPattern ? legacyPattern : new FlowArtifactLegacyPattern(legacyPattern)
      );
      this.canonicalPath = null;
    }
    Object.freeze(this);
  }
  matches(value) {
    const candidatePath = FlowArtifactRelativePath.from(value, "known Flow artifact path");
    const relativePath = candidatePath.toString();
    return this.legacyPath?.toString() === relativePath
      || this.legacyPattern?.matches(candidatePath) === true
      || this.canonicalPath?.matches(candidatePath) === true;
  }
  toString() { return this.legacyPath?.toString() ?? this.legacyPattern?.toString() ?? this.canonicalPath.toString(); }
}

const pathCharacterSet = (characters) => Object.freeze({ kind: "set", values: Object.freeze(new Set(characters)) });
const PATH_PATTERN_ALNUM = pathCharacterSet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
const PATH_PATTERN_IDENTIFIER = pathCharacterSet([...PATH_PATTERN_ALNUM.values, ".", "_", "-"]);
const PATH_PATTERN_NON_SLASH = Object.freeze({ kind: "non-slash" });

class FlowArtifactPathAutomaton {
  constructor(canonicalPath) {
    if (!(canonicalPath instanceof FlowArtifactCanonicalPath)) {
      throw new Error("artifact path automaton requires a FlowArtifactCanonicalPath");
    }
    this.transitions = new Map();
    this.nextState = 1;
    let current = 0;
    const segments = canonicalPath.toString().split("/");
    for (const [index, segment] of segments.entries()) {
      if (index > 0) current = this.#literal(current, "/");
      const wholePathParameter = segment.match(/^:\{([A-Za-z0-9][A-Za-z0-9._-]*Path)\}$/);
      if (wholePathParameter) {
        current = this.#pathParameter(current);
        continue;
      }
      const parameterPattern = /:\{([A-Za-z0-9][A-Za-z0-9._-]*)\}/g;
      let cursor = 0;
      let match;
      while ((match = parameterPattern.exec(segment)) !== null) {
        for (const character of segment.slice(cursor, match.index)) current = this.#literal(current, character);
        current = this.#identifierParameter(current);
        cursor = match.index + match[0].length;
      }
      for (const character of segment.slice(cursor)) current = this.#literal(current, character);
    }
    this.accepting = current;
    Object.freeze(this);
  }

  #state() { return this.nextState++; }
  #add(from, characters, to) {
    const entries = this.transitions.get(from) ?? [];
    entries.push(Object.freeze({ characters, to }));
    this.transitions.set(from, entries);
  }
  #literal(from, character) {
    const to = this.#state();
    this.#add(from, pathCharacterSet([character]), to);
    return to;
  }
  #identifierParameter(from) {
    const body = this.#state();
    const next = this.#state();
    this.#add(from, PATH_PATTERN_ALNUM, body);
    this.#add(body, PATH_PATTERN_IDENTIFIER, body);
    this.#add(body, null, next);
    return next;
  }
  #pathParameter(from) {
    const segment = this.#state();
    const next = this.#state();
    this.#add(from, PATH_PATTERN_NON_SLASH, segment);
    this.#add(segment, PATH_PATTERN_NON_SLASH, segment);
    this.#add(segment, pathCharacterSet(["/"]), from);
    this.#add(segment, null, next);
    return next;
  }
  epsilonClosure(states) {
    const closure = new Set(states);
    const pending = [...states];
    while (pending.length > 0) {
      const state = pending.pop();
      for (const transition of this.transitions.get(state) ?? []) {
        if (transition.characters !== null || closure.has(transition.to)) continue;
        closure.add(transition.to);
        pending.push(transition.to);
      }
    }
    return closure;
  }
  consumingTransitions(states) {
    return [...this.epsilonClosure(states)].flatMap((state) => (
      (this.transitions.get(state) ?? []).filter((transition) => transition.characters !== null)
    ));
  }
}

function characterSetsOverlap(left, right) {
  if (left.kind === "non-slash" && right.kind === "non-slash") return true;
  if (left.kind === "non-slash" || right.kind === "non-slash") {
    const set = left.kind === "set" ? left.values : right.values;
    return [...set].some((character) => character !== "/");
  }
  const smaller = left.values.size <= right.values.size ? left.values : right.values;
  const larger = smaller === left.values ? right.values : left.values;
  return [...smaller].some((character) => larger.has(character));
}

function canonicalPathsOverlap(left, right) {
  const leftAutomaton = new FlowArtifactPathAutomaton(left);
  const rightAutomaton = new FlowArtifactPathAutomaton(right);
  const pending = [[leftAutomaton.epsilonClosure([0]), rightAutomaton.epsilonClosure([0])]];
  const visited = new Set();
  while (pending.length > 0) {
    const [leftStates, rightStates] = pending.pop();
    const key = `${[...leftStates].sort((a, b) => a - b).join(",")}|${[...rightStates].sort((a, b) => a - b).join(",")}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftStates.has(leftAutomaton.accepting) && rightStates.has(rightAutomaton.accepting)) return true;
    for (const leftTransition of leftAutomaton.consumingTransitions(leftStates)) {
      for (const rightTransition of rightAutomaton.consumingTransitions(rightStates)) {
        if (!characterSetsOverlap(leftTransition.characters, rightTransition.characters)) continue;
        pending.push([
          leftAutomaton.epsilonClosure([leftTransition.to]),
          rightAutomaton.epsilonClosure([rightTransition.to]),
        ]);
      }
    }
  }
  return false;
}

function patternIsEntirelyExcluded(pattern, excludedPrefixes) {
  const literalPrefix = pattern.path.toString().split(/:\{[A-Za-z0-9][A-Za-z0-9._-]*\}/, 1)[0];
  return excludedPrefixes.some((excluded) => (
    literalPrefix.startsWith(excluded)
    || (excluded.endsWith("/") && literalPrefix === excluded.slice(0, -1))
  ));
}

function legacyEntriesOverlap(left, right) {
  const leftPattern = left instanceof FlowArtifactLegacyPattern;
  const rightPattern = right instanceof FlowArtifactLegacyPattern;
  if (!leftPattern && !rightPattern) return left.toString() === right.toString();
  if (!leftPattern) return right.matches(left.toString());
  if (!rightPattern) return left.matches(right.toString());
  if (!canonicalPathsOverlap(left.path, right.path)) return false;
  if (patternIsEntirelyExcluded(right, left.excludedPrefixes)) return false;
  if (patternIsEntirelyExcluded(left, right.excludedPrefixes)) return false;
  return true;
}

function patternInventoryIdentity(pattern) {
  return `${pattern.toString()}\0${pattern.excludedPrefixes.join("\0")}`;
}

function knownInventoryEntryIdentity(entry) {
  if (entry.legacyPath !== null) return `legacy-path:${entry.legacyPath}`;
  if (entry.legacyPattern !== null) return `legacy-pattern:${patternInventoryIdentity(entry.legacyPattern)}`;
  const type = entry.canonicalPath.parameters.length === 0 ? "canonical-path" : "canonical-pattern";
  return `${type}:${entry.canonicalPath}`;
}

function targetInventoryEntryIdentities(target) {
  if (target.action === "new") {
    const canonical = new FlowArtifactCanonicalPath(target.canonicalPath);
    const type = canonical.parameters.length === 0 ? "canonical-path" : "canonical-pattern";
    return [`${type}:${canonical}`];
  }
  return [
    ...target.legacyPaths.map((legacyPath) => `legacy-path:${legacyPath}`),
    ...target.legacyPatterns.map((legacyPattern) => `legacy-pattern:${patternInventoryIdentity(legacyPattern)}`),
  ];
}

const STEP_OWNER_MINT = Symbol("FlowArtifactStepOwner");
const REVIEW_STEP_IDS = new Set([
  "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review",
]);

/** Binds an executable Flow step identity to its canonical steps/ directory. */
export class FlowArtifactStepOwner {
  static #directoryFor(stepId) {
    if (stepId === "implement") return "impl";
    if (stepId === "retro") return "impl/retro";
    const implLeaf = stepId.match(/^impl-(review|triage|repair|gate)$/)?.[1] ?? null;
    return implLeaf === null ? stepId : path.posix.join("impl", implLeaf);
  }
  static forStep(stepId) {
    const actor = authorityActor(stepId, "artifact owner step");
    if (actor === "system" || actor.startsWith("task-")) {
      throw new Error(`artifact owner must be a concrete non-task Flow step: ${actor}`);
    }
    return new FlowArtifactStepOwner({
      publicationStep: actor,
      directoryPath: FlowArtifactStepOwner.#directoryFor(actor),
    }, STEP_OWNER_MINT);
  }
  static reviewStep(stepId) {
    const actor = identifier(stepId, "review step");
    if (!REVIEW_STEP_IDS.has(actor)) throw new Error(`invalid review artifact owner: ${actor}`);
    return FlowArtifactStepOwner.forStep(actor);
  }
  static reviewDirectory(directoryPath) {
    const ownerPath = safeRelativePath(directoryPath, "review artifact owner directory");
    const stepId = [...REVIEW_STEP_IDS].find((candidate) => (
      FlowArtifactStepOwner.#directoryFor(candidate) === ownerPath
    ));
    if (stepId === undefined) throw new Error(`invalid review artifact owner directory: ${ownerPath}`);
    return FlowArtifactStepOwner.reviewStep(stepId);
  }
  static taskCollection(segment) {
    const ownerSegment = identifier(segment, "task artifact owner segment");
    if (!new Set(["impl", "review", "triage", "repair", "gate"]).has(ownerSegment)) throw new Error("task artifact owner segment is invalid");
    return new FlowArtifactStepOwner({
      publicationStep: `task-${ownerSegment}`,
      directoryPath: path.posix.join("impl", ":{taskId}", ownerSegment),
    }, STEP_OWNER_MINT);
  }
  static taskReview(taskId) {
    return new FlowArtifactStepOwner({
      publicationStep: "task-review",
      directoryPath: path.posix.join("impl", identifier(taskId, "taskId"), "review"),
    }, STEP_OWNER_MINT);
  }
  static reviewCollection() {
    return new FlowArtifactStepOwner({ publicationStep: null, directoryPath: ":{ownerPath}" }, STEP_OWNER_MINT);
  }
  static activityEvidenceCollection() {
    return new FlowArtifactStepOwner({ publicationStep: null, directoryPath: ":{ownerPath}" }, STEP_OWNER_MINT);
  }
  constructor({ publicationStep, directoryPath } = {}, mint = null) {
    if (mint !== STEP_OWNER_MINT) throw new Error("Flow artifact step owners must be created by a typed owner factory");
    this.publicationStep = publicationStep === null ? null : authorityActor(publicationStep, "artifact owner publication step");
    this.directoryPath = new FlowArtifactCanonicalPath(safeRelativePath(directoryPath, "artifact step owner directory"));
    Object.freeze(this);
  }
  assertOwns(canonicalPath) {
    const artifactPath = canonicalPath instanceof FlowArtifactCanonicalPath
      ? canonicalPath.toString()
      : new FlowArtifactCanonicalPath(canonicalPath).toString();
    const prefix = `steps/${this.directoryPath}/`;
    if (!artifactPath.startsWith(prefix)) {
      throw new Error(`step owner ${this.directoryPath} does not own artifact path: ${artifactPath}`);
    }
    return artifactPath;
  }
  toString() { return this.directoryPath.toString(); }
}

/** Typed task-local directory resolution; task specifications remain in spec.json.tasks[]. */
export class FlowArtifactTaskOwner {
  constructor(taskId, segment) {
    this.taskId = identifier(taskId, "taskId");
    this.segment = identifier(segment, "task artifact owner segment");
    if (!new Set(["impl", "review", "triage", "repair", "gate"]).has(this.segment)) throw new Error("task artifact owner segment is invalid");
    Object.freeze(this);
  }
  toString() { return path.posix.join("steps", "impl", this.taskId, this.segment); }
}

export class FlowArtifactOwnership {
  constructor({ producers, updaters, consumers } = {}) {
    this.producers = people(producers, "artifact producers");
    this.updaters = people(updaters, "artifact updaters");
    this.consumers = people(consumers, "artifact consumers");
    Object.freeze(this);
  }
}

export class FlowArtifactAuthoritySlot {
  constructor({ kind, authority, cardinality = "singleton", publicationStep = "system" } = {}) {
    this.kind = identifier(kind, "artifact authority slot kind");
    this.authority = ArtifactAuthority.from(authority);
    this.cardinality = ArtifactCardinality.from(cardinality);
    this.publicationStep = identifier(publicationStep, "artifact authority publication step");
    Object.freeze(this);
  }
  resolve(memberId = null) {
    if (this.cardinality.value === "singleton") {
      if (memberId !== null) throw new Error("singleton artifact authority slot must not have a memberId");
      return ArtifactAuthoritySlot.singleton({ kind: this.kind, authority: this.authority, publicationStep: this.publicationStep });
    }
    return ArtifactAuthoritySlot.collectionMember({
      kind: this.kind, authority: this.authority, memberId: identifier(memberId, "artifact authority memberId"), publicationStep: this.publicationStep,
    });
  }
  claimKey(memberId = null) { return this.resolve(memberId).claimKey(); }
}

export class FlowArtifactContract {
  constructor({ logicalKey, canonicalPath, placement, stepOwner = null, mutationPolicy = "replaceable", contentContract = null, retention, ownership, authoritySlot, cataloged = true } = {}) {
    this.logicalKey = logicalKey instanceof FlowArtifactLogicalKey ? logicalKey : new FlowArtifactLogicalKey(logicalKey);
    this.canonicalPath = canonicalPath instanceof FlowArtifactCanonicalPath ? canonicalPath : new FlowArtifactCanonicalPath(canonicalPath);
    this.retention = retention instanceof FlowArtifactRetention ? retention : new FlowArtifactRetention(retention);
    this.placement = placement instanceof FlowArtifactPlacement ? placement : new FlowArtifactPlacement(placement);
    if (stepOwner !== null && !(stepOwner instanceof FlowArtifactStepOwner)) {
      throw new Error("artifact step owner must be a FlowArtifactStepOwner");
    }
    this.stepOwner = stepOwner;
    this.mutationPolicy = mutationPolicy instanceof FlowArtifactMutationPolicy ? mutationPolicy : new FlowArtifactMutationPolicy(mutationPolicy);
    if (contentContract !== null && !(contentContract instanceof FlowArtifactContentContract)) {
      throw new Error("artifact content contract must be a typed content contract");
    }
    this.contentContract = contentContract;
    this.ownership = ownership instanceof FlowArtifactOwnership ? ownership : new FlowArtifactOwnership(ownership);
    if (!(authoritySlot instanceof FlowArtifactAuthoritySlot)) throw new Error("artifact contract requires a FlowArtifactAuthoritySlot");
    this.authoritySlot = authoritySlot;
    if (cataloged !== true && cataloged !== false) throw new Error("artifact contract cataloged must be boolean");
    this.cataloged = cataloged;
    this.placement.assertCompatible({
      logicalKey: this.logicalKey.toString(), canonicalPath: this.canonicalPath,
      retention: this.retention, cataloged: this.cataloged,
    });
    if (this.placement.toString() === "step-owner") {
      if (this.stepOwner === null) throw new Error("step owner placement requires classified ownership");
      this.stepOwner.assertOwns(this.canonicalPath);
    } else if (this.stepOwner !== null) {
      throw new Error(`${this.placement} placement must not declare a step owner`);
    }
    if (!this.ownership.updaters.includes(this.authoritySlot.publicationStep)
      && !this.ownership.producers.includes(this.authoritySlot.publicationStep)) {
      throw new Error("artifact authority publication step must be a declared producer or updater");
    }
    Object.freeze(this);
  }
  resolve(parameters = {}) {
    if (this.logicalKey.toString() === "review.evidence") {
      throw new Error("review evidence must be resolved through the typed registry reviewEvidence API");
    }
    if (this.logicalKey.toString() === "activity.evidence") {
      throw new Error("activity evidence must be resolved through the typed registry activityEvidence API");
    }
    if (this.logicalKey.toString() === "final.regression.raw-log") {
      const attempt = parameters?.attempt;
      const resolvedAttempt = attempt instanceof FlowArtifactAttempt ? attempt.toString() : attempt;
      const numericAttempt = typeof resolvedAttempt === "string" && /^\d+$/.test(resolvedAttempt)
        ? Number.parseInt(resolvedAttempt, 10)
        : null;
      if (numericAttempt === null || numericAttempt < 1 || numericAttempt > FINAL_REGRESSION_MAX_ATTEMPTS
        || String(numericAttempt).padStart(3, "0") !== resolvedAttempt) {
        throw new Error("final regression raw log attempt must be a typed or canonically padded attempt between 1 and 10000");
      }
      return new ResolvedFlowArtifact(this, this.canonicalPath.resolve({ attempt: resolvedAttempt }));
    }
    if (this.logicalKey.toString() === "tests.source") {
      const testPath = safeRelativePath(parameters?.testPath, "test source path");
      if (testPath === ".raw" || testPath.startsWith(".raw/")) {
        throw new Error("test source path must not use the diagnostic .raw namespace");
      }
      return new ResolvedFlowArtifact(this, this.canonicalPath.resolve({ testPath }));
    }
    if (this.logicalKey.toString() === "plugin.lifecycle.artifact") {
      const pluginArtifactPath = safeRelativePath(parameters?.pluginArtifactPath, "plugin lifecycle artifact path");
      if (pluginArtifactPath === "workflow/ideas.json") {
        throw new Error("plugin lifecycle artifacts must not duplicate the canonical ideas artifact");
      }
      return new ResolvedFlowArtifact(this, this.canonicalPath.resolve({ pluginArtifactPath }));
    }
    return new ResolvedFlowArtifact(this, this.canonicalPath.resolve(parameters));
  }
  matchesCanonicalPath(relativePath) {
    const candidatePath = FlowArtifactRelativePath.from(relativePath, "artifact canonical path");
    const candidate = candidatePath.toString();
    const key = this.logicalKey.toString();
    if (key === "final.regression.raw-log") {
      const match = candidate.match(/^steps\/final-regression\/attempt-(\d+)\.log$/);
      if (match === null) return false;
      const attempt = Number.parseInt(match[1], 10);
      return attempt >= 1
        && attempt <= FINAL_REGRESSION_MAX_ATTEMPTS
        && String(attempt).padStart(3, "0") === match[1];
    }
    if (key === "review.evidence") {
      const match = candidate.match(/^steps\/(.+)\/evidence\/([a-f0-9]{64})\.json$/);
      if (match === null) return false;
      const taskOwner = match[1].match(/^impl\/([A-Za-z0-9][A-Za-z0-9._-]*)\/review$/);
      try {
        if (taskOwner !== null) FlowArtifactStepOwner.taskReview(taskOwner[1]);
        else FlowArtifactStepOwner.reviewDirectory(match[1]);
        return true;
      } catch {
        return false;
      }
    }
    if (key === "activity.evidence") {
      const match = candidate.match(/^steps\/(.+)\/activity-evidence\/([a-f0-9]{64})\.json$/);
      if (match === null) return false;
      try {
        FlowArtifactActivityEvidenceOwner.fromDirectory(match[1]);
        return true;
      } catch {
        return false;
      }
    }
    if (key === "tests.source" && (candidate === "artifacts/tests/.raw" || candidate.startsWith("artifacts/tests/.raw/"))) return false;
    if (key === "plugin.lifecycle.artifact" && candidate === "artifacts/plugin-artifacts/workflow/ideas.json") return false;
    return this.canonicalPath.matches(candidatePath);
  }
  authoritySlotFor(updater, memberId = null) {
    const actor = identifier(updater, "artifact updater");
    if (!this.ownership.updaters.includes(actor)) throw new Error(`artifact updater is not authorized: ${actor}`);
    return new FlowArtifactAuthoritySlot({ kind: this.authoritySlot.kind, authority: this.authoritySlot.authority, cardinality: this.authoritySlot.cardinality, publicationStep: actor }).resolve(memberId);
  }
  memberIdForPath(relativePath) {
    const candidatePath = FlowArtifactRelativePath.from(relativePath, "artifact authority path");
    const candidate = candidatePath.toString();
    if (!this.matchesCanonicalPath(candidatePath)) throw new Error(`artifact authority path does not match logical contract ${this.logicalKey}`);
    return this.authoritySlot.cardinality.value === "collection"
      ? crypto.createHash("sha256").update(candidate).digest("hex")
      : null;
  }
  authoritySlotForPath(relativePath, updater = this.authoritySlot.publicationStep) {
    return this.authoritySlotFor(updater, this.memberIdForPath(relativePath));
  }
  assertAuthoritySlot(relativePath, slot) {
    if (!(slot instanceof ArtifactAuthoritySlot)) throw new Error("artifact contract requires an ArtifactAuthoritySlot");
    const expected = this.authoritySlotForPath(relativePath, slot.publicationStep);
    if (slot.kind !== expected.kind || slot.authority.toString() !== expected.authority.toString()
      || slot.cardinality.toString() !== expected.cardinality.toString() || slot.memberId !== expected.memberId
      || slot.publicationStep !== expected.publicationStep) {
      throw new Error(`artifact authority slot does not match logical contract ${this.logicalKey}`);
    }
    return slot;
  }
  assertPublicationRole({ exists, publicationStep } = {}) {
    if (typeof exists !== "boolean") throw new Error("artifact publication existence must be boolean");
    const actor = authorityActor(publicationStep, "artifact publication step");
    const allowed = exists ? this.ownership.updaters : this.ownership.producers;
    if (!allowed.includes(actor)) {
      throw new Error(`artifact ${exists ? "updater" : "producer"} is not authorized: ${actor}`);
    }
    return actor;
  }
  assertContentPublication(previousBytes, nextBytes) {
    if (!Buffer.isBuffer(nextBytes)) throw new Error("artifact publication content must be a Buffer");
    return this.contentContract?.assertPublication(previousBytes, nextBytes) ?? null;
  }
}

export class ResolvedFlowArtifact {
  constructor(contract, relativePath) {
    if (!(contract instanceof FlowArtifactContract)) throw new Error("resolved artifact requires a FlowArtifactContract");
    this.contract = contract;
    this.logicalKey = contract.logicalKey.toString();
    this.relativePath = safeRelativePath(relativePath, "resolved artifact path");
    Object.freeze(this);
  }
  authoritySlot() { return this.contract.authoritySlotForPath(this.relativePath); }
  authoritySlotFor(updater) { return this.contract.authoritySlotForPath(this.relativePath, updater); }
  publication({ mediaType, updater = null, activityId = null } = {}) {
    return Object.freeze({
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      authoritySlot: updater === null ? this.authoritySlot() : this.authoritySlotFor(updater),
      mediaType: requiredText(mediaType, "artifact media type"),
      retention: this.contract.retention.toString(),
      activityId,
    });
  }
}

/** Review evidence binds its owner and digest into both path and collection member identity. */
export class FlowArtifactReviewEvidence {
  constructor(contract, { owner, digest } = {}) {
    if (!(owner instanceof FlowArtifactStepOwner)) throw new Error("review evidence requires a typed review owner");
    const evidenceDigest = requiredText(digest, "review evidence digest");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error("review evidence digest must be a lowercase SHA-256 digest");
    if (!(contract instanceof FlowArtifactContract)) throw new Error("review evidence requires a FlowArtifactContract");
    this.contract = contract;
    this.logicalKey = contract.logicalKey.toString();
    this.relativePath = contract.canonicalPath.resolve({ ownerPath: owner.toString(), digest: evidenceDigest });
    this.owner = owner;
    this.digest = evidenceDigest;
    this.memberId = contract.memberIdForPath(this.relativePath);
    Object.freeze(this);
  }
  static fromCanonicalPath(contract, relativePath) {
    if (!(contract instanceof FlowArtifactContract) || contract.logicalKey.toString() !== "review.evidence") {
      throw new Error("review evidence canonical path requires its review.evidence contract");
    }
    const match = safeRelativePath(relativePath, "review evidence canonical path").match(/^steps\/(.+)\/evidence\/([a-f0-9]{64})\.json$/);
    if (!match) throw new Error("review evidence canonical path must contain a typed owner and digest");
    const [, ownerPath, digest] = match;
    const taskOwner = ownerPath.match(/^impl\/([A-Za-z0-9][A-Za-z0-9._-]*)\/review$/);
    const owner = taskOwner === null
      ? FlowArtifactStepOwner.reviewDirectory(ownerPath)
      : FlowArtifactStepOwner.taskReview(taskOwner[1]);
    const evidence = new FlowArtifactReviewEvidence(contract, { owner, digest });
    if (evidence.relativePath !== relativePath) throw new Error("review evidence canonical path does not match its typed owner");
    return evidence;
  }
  publicationStep() {
    if (this.owner.publicationStep === null) throw new Error("review evidence owner has no publication step");
    return this.owner.publicationStep;
  }
  assertAuthoritySlot(slot) {
    if (!(slot instanceof ArtifactAuthoritySlot)) throw new Error("review evidence requires an ArtifactAuthoritySlot");
    const expected = this.authoritySlotFor(this.publicationStep());
    if (slot.kind !== expected.kind || slot.authority.toString() !== expected.authority.toString()
      || slot.cardinality.toString() !== expected.cardinality.toString() || slot.memberId !== expected.memberId
      || slot.publicationStep !== expected.publicationStep) {
      throw new Error("review evidence authority slot must be derived from its typed owner and digest");
    }
    return slot;
  }
  authoritySlotFor(updater) { return this.contract.authoritySlotFor(updater, this.memberId); }
  publication({ mediaType, updater, activityId = null } = {}) {
    return Object.freeze({
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      authoritySlot: this.authoritySlotFor(updater),
      mediaType: requiredText(mediaType, "artifact media type"),
      retention: this.contract.retention.toString(),
      activityId,
    });
  }
}

const ACTIVITY_EVIDENCE_MINT = Symbol("FlowArtifactActivityEvidenceOwner");

function isoTimestamp(value, field) {
  const timestamp = requiredText(value, field);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`);
  return timestamp;
}

function jsonPointer(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a JSON Pointer string`);
  if (value === "") return value;
  if (!value.startsWith("/") || /~(?:[^01]|$)/.test(value)) {
    throw new Error(`${field} must be an RFC6901 JSON Pointer`);
  }
  return value;
}

/**
 * The immutable owner address for an Activity evidence artifact.  It retains
 * the real Activity node identity: `flow` has the typed system owner and a
 * task leaf remains under its own Task directory.  No synthetic Step is
 * invented for a root observation.
 */
export class FlowArtifactActivityEvidenceOwner {
  static forNodeId(value) {
    const nodeId = requiredText(value, "activity evidence nodeId");
    if (nodeId === "flow") {
      return new FlowArtifactActivityEvidenceOwner({
        nodeId,
        publicationStep: FlowArtifactUpdater.fromActivityNodeId(nodeId).toString(),
        directoryPath: "system",
      }, ACTIVITY_EVIDENCE_MINT);
    }
    // `impl` is a composite historical node whose Activity updater is the
    // system actor.  It cannot share `steps/impl` with the concrete
    // `implement` producer, so its system namespace stays explicit.
    if (nodeId === "impl") {
      return new FlowArtifactActivityEvidenceOwner({
        nodeId,
        publicationStep: FlowArtifactUpdater.fromActivityNodeId(nodeId).toString(),
        directoryPath: "system/impl",
      }, ACTIVITY_EVIDENCE_MINT);
    }
    // Static Flow leaves have their own typed owners.  Task leaves are not
    // inferred from an id suffix: a caller must prove the Task parent with
    // forTaskNode(), so an old Step such as `legacy-review` cannot become a
    // fictitious Task named `legacy`.
    if (AUTHORITY_ACTORS.has(nodeId)) {
      return new FlowArtifactActivityEvidenceOwner({
        nodeId,
        publicationStep: FlowArtifactUpdater.fromActivityNodeId(nodeId).toString(),
        directoryPath: FlowArtifactStepOwner.forStep(nodeId).toString(),
      }, ACTIVITY_EVIDENCE_MINT);
    }
    throw new Error(`activity evidence nodeId is not a concrete current Flow leaf: ${nodeId}`);
  }

  /**
   * Current Task evidence requires the state-derived Task parent and exact
   * child segment.  Node-id spelling alone is intentionally insufficient.
   */
  static forTaskNode({ taskId, segment } = {}) {
    const owner = new FlowArtifactTaskOwner(taskId, segment);
    const nodeId = `${owner.taskId}-${owner.segment}`;
    return new FlowArtifactActivityEvidenceOwner({
      nodeId,
      publicationStep: FlowArtifactUpdater.fromActivityNodeId(nodeId).toString(),
      directoryPath: owner.toString().slice("steps/".length),
    }, ACTIVITY_EVIDENCE_MINT);
  }

  /**
   * An explicit authority for a node retained only in historical state.  The
   * caller must opt into this namespace after the state boundary has ruled
   * out a current Task parent.  It rejects all current Flow identities but
   * deliberately does not classify an arbitrary `*-review` spelling here.
   */
  static forHistoricalNodeId(value) {
    const nodeId = identifier(value, "historical activity evidence nodeId");
    if (nodeId === "flow" || nodeId === "impl" || AUTHORITY_ACTORS.has(nodeId)) {
      throw new Error(`historical activity evidence nodeId is already a current Flow node: ${nodeId}`);
    }
    return new FlowArtifactActivityEvidenceOwner({
      nodeId,
      publicationStep: "system",
      directoryPath: path.posix.join("historical", nodeId),
      historical: true,
    }, ACTIVITY_EVIDENCE_MINT);
  }

  static fromDirectory(directoryPath) {
    const ownerPath = safeRelativePath(directoryPath, "activity evidence owner directory");
    if (ownerPath === "system") return FlowArtifactActivityEvidenceOwner.forNodeId("flow");
    if (ownerPath === "system/impl") return FlowArtifactActivityEvidenceOwner.forNodeId("impl");
    const historicalMatch = ownerPath.match(/^historical\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (historicalMatch !== null) {
      return FlowArtifactActivityEvidenceOwner.forHistoricalNodeId(historicalMatch[1]);
    }
    const taskMatch = ownerPath.match(/^impl\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(impl|review|triage|repair|gate)$/);
    if (taskMatch !== null) {
      return FlowArtifactActivityEvidenceOwner.forTaskNode({ taskId: taskMatch[1], segment: taskMatch[2] });
    }
    const staticNodeId = [...AUTHORITY_ACTORS]
      .filter((nodeId) => nodeId !== "system" && !nodeId.startsWith("task-"))
      .find((nodeId) => FlowArtifactStepOwner.forStep(nodeId).toString() === ownerPath);
    if (staticNodeId === undefined) throw new Error(`invalid activity evidence owner directory: ${ownerPath}`);
    return FlowArtifactActivityEvidenceOwner.forNodeId(staticNodeId);
  }

  constructor({ nodeId, publicationStep, directoryPath, historical = false } = {}, mint = null) {
    if (mint !== ACTIVITY_EVIDENCE_MINT) {
      throw new Error("activity evidence owners must be created by a typed owner factory");
    }
    this.nodeId = requiredText(nodeId, "activity evidence nodeId");
    this.publicationStep = authorityActor(publicationStep, "activity evidence publication step");
    this.directoryPath = new FlowArtifactCanonicalPath(safeRelativePath(directoryPath, "activity evidence owner directory"));
    if (typeof historical !== "boolean") throw new Error("activity evidence owner historical flag is invalid");
    this.historical = historical;
    if (this.historical) {
      if (!IDENTIFIER.test(this.nodeId) || this.publicationStep !== "system"
        || this.directoryPath.toString() !== path.posix.join("historical", this.nodeId)) {
        throw new Error("historical activity evidence owner must retain its node identity under the system namespace");
      }
    } else if (FlowArtifactUpdater.fromActivityNodeId(this.nodeId).toString() !== this.publicationStep) {
      throw new Error("activity evidence owner publication step does not match its node");
    }
    Object.freeze(this);
  }

  toString() { return this.directoryPath.toString(); }
}

/** Typed, owner-bound address for immutable evidence referenced by an Activity. */
export class FlowArtifactActivityEvidence {
  constructor(contract, { owner, digest } = {}) {
    if (!(owner instanceof FlowArtifactActivityEvidenceOwner)) {
      throw new Error("activity evidence requires a typed Activity owner");
    }
    const evidenceDigest = requiredText(digest, "activity evidence digest");
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) {
      throw new Error("activity evidence digest must be a lowercase SHA-256 digest");
    }
    if (!(contract instanceof FlowArtifactContract) || contract.logicalKey.toString() !== "activity.evidence") {
      throw new Error("activity evidence requires an activity.evidence contract");
    }
    this.contract = contract;
    this.logicalKey = contract.logicalKey.toString();
    this.owner = owner;
    this.digest = evidenceDigest;
    this.relativePath = contract.canonicalPath.resolve({ ownerPath: owner.toString(), digest: evidenceDigest });
    this.memberId = contract.memberIdForPath(this.relativePath);
    Object.freeze(this);
  }

  static fromCanonicalPath(contract, relativePath) {
    if (!(contract instanceof FlowArtifactContract) || contract.logicalKey.toString() !== "activity.evidence") {
      throw new Error("activity evidence canonical path requires its activity.evidence contract");
    }
    const match = safeRelativePath(relativePath, "activity evidence canonical path")
      .match(/^steps\/(.+)\/activity-evidence\/([a-f0-9]{64})\.json$/);
    if (match === null) throw new Error("activity evidence canonical path must contain a typed owner and digest");
    const [, ownerPath, digest] = match;
    const evidence = new FlowArtifactActivityEvidence(contract, {
      owner: FlowArtifactActivityEvidenceOwner.fromDirectory(ownerPath),
      digest,
    });
    if (evidence.relativePath !== relativePath) throw new Error("activity evidence canonical path does not match its typed owner");
    return evidence;
  }

  publication({ mediaType, updater, activityId = null } = {}) {
    const actor = authorityActor(updater, "activity evidence updater");
    if (actor !== this.owner.publicationStep) {
      throw new Error("activity evidence updater does not own its evidence path");
    }
    return Object.freeze({
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      authoritySlot: this.contract.authoritySlotFor(actor, this.memberId),
      mediaType: requiredText(mediaType, "artifact media type"),
      retention: this.contract.retention.toString(),
      activityId,
    });
  }

  assertAuthoritySlot(slot) {
    if (!(slot instanceof ArtifactAuthoritySlot)) throw new Error("activity evidence requires an ArtifactAuthoritySlot");
    const expected = this.contract.authoritySlotFor(this.owner.publicationStep, this.memberId);
    if (slot.kind !== expected.kind || slot.authority.toString() !== expected.authority.toString()
      || slot.cardinality.toString() !== expected.cardinality.toString() || slot.memberId !== expected.memberId
      || slot.publicationStep !== expected.publicationStep) {
      throw new Error("activity evidence authority slot must be derived from its typed owner and digest");
    }
    return slot;
  }
}

/** The immutable JSON payload attached to one cataloged Activity evidence file. */
export class FlowArtifactActivityEvidenceDocument {
  constructor(value = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "activityId,note,observedAt,owner,schemaRevision,source") {
      throw new Error("activity evidence document must contain only schemaRevision, activityId, owner, observedAt, source, and note");
    }
    const { schemaRevision, activityId, owner, observedAt, source, note } = value;
    if (schemaRevision !== 1) throw new Error("unsupported activity evidence schemaRevision");
    if (activityId !== identifier(activityId, "activity evidence activityId")) {
      throw new Error("activity evidence activityId is invalid");
    }
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)
      || Object.keys(owner).sort().join(",") !== "nodeId,nodeKey") {
      throw new Error("activity evidence owner must contain only nodeId and nodeKey");
    }
    this.owner = Object.freeze({
      nodeId: requiredText(owner.nodeId, "activity evidence owner.nodeId"),
      nodeKey: identifier(owner.nodeKey, "activity evidence owner.nodeKey"),
    });
    if (source === null || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "hash,path,pointer") {
      throw new Error("activity evidence source must contain only path, pointer, and hash");
    }
    const hash = requiredText(source.hash, "activity evidence source.hash");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("activity evidence source.hash must be a lowercase SHA-256 digest");
    this.schemaRevision = schemaRevision;
    this.activityId = identifier(activityId, "activity evidence activityId");
    this.observedAt = isoTimestamp(observedAt, "activity evidence observedAt");
    this.source = Object.freeze({
      path: safeRelativePath(source.path, "activity evidence source.path"),
      pointer: jsonPointer(source.pointer, "activity evidence source.pointer"),
      hash,
    });
    this.note = requiredText(note, "activity evidence note");
    Object.freeze(this);
  }

  static fromJSON(value) { return new FlowArtifactActivityEvidenceDocument(value); }

  toJSON() {
    return {
      schemaRevision: this.schemaRevision,
      activityId: this.activityId,
      owner: { ...this.owner },
      observedAt: this.observedAt,
      source: { ...this.source },
      note: this.note,
    };
  }
}

/** Validates immutable Activity evidence bytes and their ledger association. */
export class FlowArtifactActivityEvidenceContent extends FlowArtifactContentContract {
  constructor() { super(); Object.freeze(this); }

  parse(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("activity evidence content must be a Buffer");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
      throw new Error(`activity evidence must be valid JSON: ${error.message}`);
    }
    return FlowArtifactActivityEvidenceDocument.fromJSON(value);
  }

  assertPublication(previousBytes, nextBytes) {
    const next = this.parse(nextBytes);
    if (previousBytes !== null) {
      const previous = this.parse(previousBytes);
      if (JSON.stringify(previous.toJSON()) !== JSON.stringify(next.toJSON())) {
        throw new Error("immutable activity evidence cannot replace existing bytes");
      }
    }
    return next;
  }

  assertCatalogAssociation({ bytes, descriptor, activity } = {}) {
    const document = this.parse(bytes);
    if (descriptor?.activityId === null || descriptor?.activityId === undefined) {
      throw new Error("activity evidence descriptor requires its Activity association");
    }
    if (document.activityId !== descriptor.activityId) {
      throw new Error("activity evidence document Activity id does not match its descriptor");
    }
    if (document.owner.nodeId !== activity?.nodeId || document.owner.nodeKey !== activity?.nodeKey) {
      throw new Error("activity evidence document owner does not match its Activity");
    }
    const contract = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence");
    const artifact = FlowArtifactActivityEvidence.fromCanonicalPath(contract, descriptor.relativePath);
    if (artifact.owner.nodeId !== activity.nodeId || artifact.owner.publicationStep !== descriptor.slot.publicationStep) {
      throw new Error("activity evidence path owner does not match its Activity provenance");
    }
    return document;
  }
}

class FlowArtifactContractPathIndex {
  #contractsByStaticPrefix;

  constructor(contracts) {
    const grouped = new Map();
    for (const contract of contracts) {
      const segments = contract.canonicalPath.toString().split("/");
      const parameterIndex = segments.findIndex((segment) => segment.includes(":{"));
      const prefix = segments.slice(0, parameterIndex < 0 ? segments.length : parameterIndex).join("/");
      const bucket = grouped.get(prefix) ?? [];
      bucket.push(contract);
      grouped.set(prefix, bucket);
    }
    this.#contractsByStaticPrefix = new Map(
      [...grouped].map(([prefix, entries]) => [prefix, Object.freeze(entries)]),
    );
    Object.freeze(this);
  }

  candidates(relativePath) {
    const segments = relativePath.toString().split("/");
    const candidates = [];
    for (let length = 0; length <= segments.length; length += 1) {
      const bucket = this.#contractsByStaticPrefix.get(segments.slice(0, length).join("/"));
      if (bucket) candidates.push(...bucket);
    }
    return candidates;
  }
}

export class FlowArtifactRegistry {
  #canonicalPathIndex;
  #canonicalContractsByPath = new Map();
  #knownFilesByPath = new Map();

  constructor({ contracts, legacyTargets = [], switchTargets = [], knownFiles = [] } = {}) {
    if (!Array.isArray(contracts) || contracts.some((contract) => !(contract instanceof FlowArtifactContract))) {
      throw new Error("artifact registry requires typed contracts");
    }
    this.byKey = new Map();
    this.byPath = new Map();
    this.byAuthority = new Map();
    for (const contract of contracts) {
      const key = contract.logicalKey.toString();
      const canonicalPath = contract.canonicalPath.toString();
      const authority = contract.authoritySlot.claimKey(contract.authoritySlot.cardinality.value === "collection" ? "member" : null);
      if (this.byKey.has(key)) throw new Error(`duplicate artifact logical key: ${key}`);
      if (this.byPath.has(canonicalPath)) throw new Error(`duplicate artifact canonical path: ${canonicalPath}`);
      if (this.byAuthority.has(authority)) throw new Error(`duplicate artifact authority slot: ${authority}`);
      this.byKey.set(key, contract);
      this.byPath.set(canonicalPath, contract);
      this.byAuthority.set(authority, contract);
    }
    for (let left = 0; left < contracts.length; left += 1) {
      for (let right = left + 1; right < contracts.length; right += 1) {
        const leftPath = contracts[left].canonicalPath;
        const rightPath = contracts[right].canonicalPath;
        if (canonicalPathsOverlap(leftPath, rightPath)) {
          throw new Error(`overlapping artifact canonical paths: ${leftPath} / ${rightPath}`);
        }
      }
    }
    for (const contract of contracts) {
      if (contract.cataloged && contract.canonicalPath.parameters.length > 0
        && contract.authoritySlot.cardinality.value !== "collection") {
        throw new Error(`parameterized catalog artifact paths require collection authority: ${contract.logicalKey}`);
      }
    }
    const rootKeys = new Set(contracts.filter((contract) => !contract.canonicalPath.toString().includes("/")).map((contract) => contract.logicalKey.toString()));
    for (const key of ROOT_ARTIFACT_KEYS) if (!rootKeys.has(key)) throw new Error(`artifact registry is missing root contract: ${key}`);
    for (const key of rootKeys) if (!ROOT_ARTIFACT_KEYS.has(key)) throw new Error(`unclassified root artifact contract: ${key}`);
    this.#canonicalPathIndex = new FlowArtifactContractPathIndex(contracts);
    this.legacyTargets = Object.freeze(legacyTargets.map((target) => target instanceof FlowArtifactLegacyTarget ? target : new FlowArtifactLegacyTarget(target)));
    if (new Set(this.legacyTargets.map(String)).size !== this.legacyTargets.length) throw new Error("duplicate legacy artifact target");
    if (this.legacyTargets.some((target) => this.byPath.has(target.toString()))) throw new Error("legacy artifact target must not be a canonical contract");
    if (!Array.isArray(switchTargets) || switchTargets.some((target) => !(target instanceof FlowArtifactSwitchTarget))) {
      throw new Error("artifact registry requires typed switch targets");
    }
    this.switchTargets = Object.freeze([...switchTargets]);
    const switchKeys = new Set();
    const oldPaths = new Set();
    const oldEntries = [];
    for (const target of this.switchTargets) {
      if (switchKeys.has(target.logicalKey)) throw new Error(`duplicate artifact switch logical key: ${target.logicalKey}`);
      switchKeys.add(target.logicalKey);
      for (const legacyPath of [...target.legacyPaths, ...target.legacyPatterns]) {
        const key = legacyPath.toString();
        if (oldPaths.has(key)) throw new Error(`duplicate legacy artifact switch path: ${key}`);
        if (oldEntries.some((existing) => legacyEntriesOverlap(existing, legacyPath))) {
          throw new Error(`overlapping legacy artifact switch paths: ${key}`);
        }
        oldPaths.add(key);
        oldEntries.push(legacyPath);
      }
      const contract = this.byKey.get(target.logicalKey);
      if (target.action === "remove") {
        if (contract) throw new Error(`remove target must not classify canonical contract: ${target.logicalKey}`);
        continue;
      }
      if (!contract) throw new Error(`switch target has no canonical contract: ${target.logicalKey}`);
      if (contract.canonicalPath.toString() !== target.canonicalPath) {
        throw new Error(`switch target canonical path does not match contract: ${target.logicalKey}`);
      }
      if (!contract.ownership.producers.includes(target.producer)) {
        throw new Error(`switch target producer is not declared by canonical ownership: ${target.logicalKey}`);
      }
      if (!contract.ownership.consumers.includes(target.consumer)) {
        throw new Error(`switch target consumer is not declared by canonical ownership: ${target.logicalKey}`);
      }
    }
    for (const key of this.byKey.keys()) {
      if (!switchKeys.has(key)) throw new Error(`canonical artifact contract has no switch classification: ${key}`);
    }
    if (!Array.isArray(knownFiles) || knownFiles.some((entry) => !(entry instanceof FlowArtifactKnownFile))) {
      throw new Error("artifact registry requires typed normal Flow inventory entries");
    }
    this.knownFiles = Object.freeze([...knownFiles]);
    const knownSources = new Set();
    const knownEntries = [];
    for (const entry of this.knownFiles) {
      const entryIdentity = knownInventoryEntryIdentity(entry);
      if (knownSources.has(entryIdentity)) throw new Error(`duplicate known Flow artifact path: ${entry}`);
      const legacy = entry.legacyPath ?? entry.legacyPattern;
      if (legacy !== null && knownEntries.some((existing) => legacyEntriesOverlap(existing, legacy))) {
        throw new Error(`overlapping known Flow artifact paths: ${entry}`);
      }
      knownSources.add(entryIdentity);
      if (legacy !== null) knownEntries.push(legacy);
      const target = this.switchTargets.find((candidate) => candidate.logicalKey === entry.logicalKey);
      if (!target) throw new Error(`known Flow artifact has no target: ${entry.logicalKey}`);
      if (target.action !== entry.action) throw new Error(`known Flow artifact action does not match target: ${entry.logicalKey}`);
      if (!targetInventoryEntryIdentities(target).includes(entryIdentity)) {
        throw new Error(`known Flow artifact is absent from its switch target: ${entry}`);
      }
    }
    for (const target of this.switchTargets) {
      for (const targetEntry of targetInventoryEntryIdentities(target)) {
        const matches = this.knownFiles.filter((entry) => (
          entry.logicalKey === target.logicalKey && entry.action === target.action
          && knownInventoryEntryIdentity(entry) === targetEntry
        ));
        if (matches.length !== 1) {
          throw new Error(`switch target inventory entry must be declared exactly once: ${target.logicalKey}/${targetEntry}`);
        }
      }
    }
    Object.freeze(this);
  }
  require(logicalKey) {
    const contract = this.byKey.get(new FlowArtifactLogicalKey(logicalKey).toString());
    if (!contract) throw new Error(`unknown artifact logical key: ${logicalKey}`);
    return contract;
  }
  resolve(logicalKey, parameters = {}) { return this.require(logicalKey).resolve(parameters); }
  reviewEvidence({ reviewStep = null, taskId = null, digest } = {}) {
    if ((reviewStep === null) === (taskId === null)) {
      throw new Error("review evidence requires exactly one review step or taskId owner");
    }
    const owner = taskId == null ? FlowArtifactStepOwner.reviewStep(identifier(reviewStep, "review step")) : FlowArtifactStepOwner.taskReview(taskId);
    return new FlowArtifactReviewEvidence(this.require("review.evidence"), { owner, digest });
  }
  activityEvidence({ nodeId, digest } = {}) {
    return new FlowArtifactActivityEvidence(this.require("activity.evidence"), {
      owner: FlowArtifactActivityEvidenceOwner.forNodeId(nodeId),
      digest,
    });
  }
  taskActivityEvidence({ taskId, segment, digest } = {}) {
    return new FlowArtifactActivityEvidence(this.require("activity.evidence"), {
      owner: FlowArtifactActivityEvidenceOwner.forTaskNode({ taskId, segment }),
      digest,
    });
  }
  historicalActivityEvidence({ nodeId, digest } = {}) {
    return new FlowArtifactActivityEvidence(this.require("activity.evidence"), {
      owner: FlowArtifactActivityEvidenceOwner.forHistoricalNodeId(nodeId),
      digest,
    });
  }
  taskDirectory(taskId, segment) { return new FlowArtifactTaskOwner(taskId, segment).toString(); }
  finalRegressionRawLog(attempt) { return this.require("final.regression.raw-log").resolve({ attempt: attempt instanceof FlowArtifactAttempt ? attempt : new FlowArtifactAttempt(attempt) }); }
  classify(relativePath) {
    const candidate = FlowArtifactRelativePath.from(relativePath, "artifact canonical path");
    const cached = this.#canonicalContractsByPath.get(candidate.toString());
    if (cached !== undefined) return cached;
    const matches = this.#canonicalPathIndex.candidates(candidate)
      .filter((contract) => contract.matchesCanonicalPath(candidate));
    if (matches.length !== 1) throw new Error(`artifact path is not uniquely classified: ${relativePath}`);
    this.#canonicalContractsByPath.set(candidate.toString(), matches[0]);
    return matches[0];
  }
  isLegacyTarget(relativePath) { return this.legacyTargets.some((target) => target.toString() === safeRelativePath(relativePath, "legacy artifact target")); }
  inventory() { return Object.freeze([...this.byKey.values()]); }
  target(logicalKey) {
    const key = new FlowArtifactLogicalKey(logicalKey).toString();
    const target = this.switchTargets.find((candidate) => candidate.logicalKey === key);
    if (!target) throw new Error(`unknown artifact switch target: ${logicalKey}`);
    return target;
  }
  classifyKnownFile(relativePath) {
    const candidate = FlowArtifactRelativePath.from(relativePath, "known Flow artifact path");
    const cached = this.#knownFilesByPath.get(candidate.toString());
    if (cached !== undefined) return cached;
    const matches = this.knownFiles.filter((entry) => entry.matches(candidate));
    if (matches.length !== 1) throw new Error(`known Flow artifact path is not uniquely classified: ${relativePath}`);
    this.#knownFilesByPath.set(candidate.toString(), matches[0]);
    return matches[0];
  }
}

const FLOW_ARTIFACT_PLACEMENTS = new Map([
  ...["flow.state", "flow.activities", "spec.record", "issue.log", "artifact.catalog", "issue.snapshot"].map((key) => [key, new FlowArtifactPlacement("root-authority")]),
  ...["spec.snapshot", "spec.review"].map((key) => [key, new FlowArtifactPlacement("revision-authority")]),
  ...["report", "ideas", "tests.source", "plugin.lifecycle.artifact", "retry.recovery.baseline", "retry.recovery.receipt"].map((key) => [key, new FlowArtifactPlacement("independent-deliverable")]),
  ...["upgrade.result", "completion.overrides", "retry.recovery", "flow.findings", "nonblocking.handoffs"].map((key) => [key, new FlowArtifactPlacement("step-shared")]),
  ...[
    "scenario.validity.raw-log", "test.execute.raw-log", "final.regression.raw-log",
    "retry.recovery.transaction", "impl.repair.transaction", "test.requirement.summary", "review.work.unit",
    "finalize.cleanup.runtime-log", "finalize.cleanup.journal", "runtime.step-metadata",
    "runtime.lock.issue-log", "runtime.lock.current-flow-state", "runtime.lock.artifact-catalog",
    "runtime.lock.retry-recovery", "runtime.lock.flow-state-writer", "runtime.lock.flow-state-writer-owner", "runtime.lock.impl-repair",
    "runtime.lock.issue-log-owner", "runtime.lock.current-flow-state-owner", "runtime.lock.artifact-catalog-owner", "runtime.lock.retry-recovery-owner",
  ].map((key) => [key, new FlowArtifactPlacement("transient")]),
  ...[
    "draft", "draft.questions.review", "draft.questions.triage", "draft.questions.repair",
    "draft.coverage.review", "draft.coverage.triage", "draft.coverage.repair", "draft.gate.source", "draft.gate",
    "spec.gate.source", "spec.gate", "scenario.validity",
    "test.review", "test.review.repair.progress", "test.bootstrap.observation", "test.execute", "test.result.review", "impl.review", "impl.triage", "impl.repair",
    "impl.gate.source", "impl.gate", "retro", "acceptance.review", "acceptance.review.evidence", "acceptance.decision", "final.regression",
    "file.map", "placeholder.permission", "gate.memory", "repair.fingerprint", "repair.delta", "repair.migration",
    "task.triage", "task.repair", "task.review", "task.triage.source.handoff.baseline", "task.repair.source.handoff.baseline", "task.review.unsealed.checkpoint", "task.review.recovery.authorization", "task.review.reconciliation", "task.review.aborted.work-unit", "task.gate.source", "task.gate", "task.mutation.lineage", "review.evidence", "activity.evidence",
    "finalize.cleanup.agent-metrics", "finalize.cleanup.notes", "finalize.cleanup.plugin-artifacts",
  ].map((key) => [key, new FlowArtifactPlacement("step-owner")]),
]);

const FLOW_ARTIFACT_MUTATION_POLICIES = new Map([
  ["task.review.reconciliation", new FlowArtifactMutationPolicy("immutable")],
  ["spec.snapshot", new FlowArtifactMutationPolicy("immutable")],
  ["review.evidence", new FlowArtifactMutationPolicy("immutable")],
  ["activity.evidence", new FlowArtifactMutationPolicy("immutable")],
]);

const FLOW_ARTIFACT_ATTEMPT_HISTORY_KEYS = new Set([
  "draft.questions.review", "draft.coverage.review", "scenario.validity",
  "test.review", "test.execute", "test.result.review", "impl.review", "task.review", "task.triage", "task.repair",
  // Gates are ordinary producer Steps, not a mutable side file.  Retaining
  // each completed gate evaluation here gives retry/recovery the same
  // ordered Attempt history as reviews and test execution.
  "draft.gate", "spec.gate", "impl.gate", "task.gate",
  "acceptance.review", "acceptance.decision", "final.regression",
]);
const FLOW_ARTIFACT_ATTEMPT_HISTORY_CONTENT = new FlowArtifactAttemptHistoryContent();
const FLOW_ARTIFACT_ACTIVITY_EVIDENCE_CONTENT = new FlowArtifactActivityEvidenceContent();

function placementFor(logicalKey) {
  const placement = FLOW_ARTIFACT_PLACEMENTS.get(logicalKey);
  if (!placement) throw new Error(`artifact contract is missing placement: ${logicalKey}`);
  return placement;
}

function mutationPolicyFor(logicalKey) {
  return FLOW_ARTIFACT_MUTATION_POLICIES.get(logicalKey) ?? new FlowArtifactMutationPolicy("replaceable");
}

const FLOW_ARTIFACT_OWNER_STEP_BY_KEY = new Map([
  ["draft", "draft"],
  ["draft.questions.review", "draft-questions-review"],
  ["draft.questions.triage", "draft-questions-triage"],
  ["draft.questions.repair", "draft-questions-repair"],
  ["draft.coverage.review", "draft-coverage-review"],
  ["draft.coverage.triage", "draft-coverage-triage"],
  ["draft.coverage.repair", "draft-coverage-repair"],
  ["draft.gate.source", "draft-gate"],
  ["draft.gate", "draft-gate"],
  ["spec.gate.source", "spec-gate"],
  ["spec.gate", "spec-gate"],
  ["scenario.validity", "scenario-validity"],
  ["test.review", "test-review"],
  ["test.review.repair.progress", "test"],
  ["test.bootstrap.observation", "test"],
  ["test.execute", "test-execute"],
  ["test.result.review", "test-result-review"],
  ["impl.review", "impl-review"],
  ["impl.triage", "impl-triage"],
  ["impl.repair", "impl-repair"],
  ["impl.gate.source", "impl-gate"],
  ["impl.gate", "impl-gate"],
  ["retro", "retro"],
  ["acceptance.review", "acceptance-review"],
  ["acceptance.review.evidence", "acceptance-review"],
  ["acceptance.decision", "acceptance-decision"],
  ["final.regression", "final-regression"],
  ["file.map", "implement"],
  ["placeholder.permission", "test"],
  ["gate.memory", "impl-gate"],
  ["repair.fingerprint", "impl-repair"],
  ["repair.delta", "impl-repair"],
  ["repair.migration", "impl-repair"],
  ["finalize.cleanup.agent-metrics", "finalize-cleanup"],
  ["finalize.cleanup.notes", "finalize-cleanup"],
  ["finalize.cleanup.plugin-artifacts", "finalize-cleanup"],
]);

function stepOwnerFor(logicalKey) {
  if (placementFor(logicalKey).toString() !== "step-owner") return null;
  if (["task.review", "task.review.unsealed.checkpoint", "task.review.recovery.authorization", "task.review.reconciliation", "task.review.aborted.work-unit"].includes(logicalKey)) return FlowArtifactStepOwner.taskCollection("review");
  if (logicalKey === "task.triage") return FlowArtifactStepOwner.taskCollection("triage");
  if (logicalKey === "task.repair") return FlowArtifactStepOwner.taskCollection("repair");
  if (logicalKey === "task.triage.source.handoff.baseline") return FlowArtifactStepOwner.taskCollection("triage");
  if (logicalKey === "task.repair.source.handoff.baseline") return FlowArtifactStepOwner.taskCollection("repair");
  if (logicalKey === "task.gate.source" || logicalKey === "task.gate") return FlowArtifactStepOwner.taskCollection("gate");
  if (logicalKey === "task.mutation.lineage") return FlowArtifactStepOwner.taskCollection("impl");
  if (logicalKey === "review.evidence") return FlowArtifactStepOwner.reviewCollection();
  if (logicalKey === "activity.evidence") return FlowArtifactStepOwner.activityEvidenceCollection();
  const stepId = FLOW_ARTIFACT_OWNER_STEP_BY_KEY.get(logicalKey);
  if (stepId === undefined) throw new Error(`artifact contract is missing a classified step owner: ${logicalKey}`);
  return FlowArtifactStepOwner.forStep(stepId);
}

function contract(logicalKey, canonicalPath, kind, authority, publicationStep, ownership, retention = "permanent", cardinality = "singleton", cataloged = true) {
  return new FlowArtifactContract({
    logicalKey, canonicalPath, placement: placementFor(logicalKey), mutationPolicy: mutationPolicyFor(logicalKey),
    stepOwner: stepOwnerFor(logicalKey),
    contentContract: FLOW_ARTIFACT_ATTEMPT_HISTORY_KEYS.has(logicalKey)
      ? FLOW_ARTIFACT_ATTEMPT_HISTORY_CONTENT
      : logicalKey === "activity.evidence" ? FLOW_ARTIFACT_ACTIVITY_EVIDENCE_CONTENT : null,
    retention, ownership, cataloged,
    authoritySlot: new FlowArtifactAuthoritySlot({ kind, authority, publicationStep, cardinality }),
  });
}

const own = (producers, updaters, consumers) => ({
  producers: Array.isArray(producers) ? producers : [producers],
  updaters,
  consumers,
});
const NORMAL_FLOW_STEP_ACTORS = Object.freeze([...AUTHORITY_ACTORS].filter((actor) => actor !== "system"));
const FLOW_WIDE_RECORD_ACTORS = Object.freeze(["system", ...NORMAL_FLOW_STEP_ACTORS]);
const FLOW_FINDING_SOURCE_ACTORS = Object.freeze([
  "draft-questions-review", "draft-coverage-review", "draft-gate", "spec-review", "spec-gate",
  "scenario-validity", "test-review", "test-result-review", "task-review", "task-gate",
  "impl-review", "impl-gate", "retro",
]);
const NONBLOCKING_HANDOFF_SOURCE_ACTORS = Object.freeze([
  "scenario-validity", "test-result-review", "retro",
]);
export const FLOW_ARTIFACT_NO_ARTIFACT_STEPS = Object.freeze([
  new FlowArtifactNoArtifactClassification("branch", "selects execution checkout"),
  new FlowArtifactNoArtifactClassification("finalize-commit", "delegates repository commit"),
  new FlowArtifactNoArtifactClassification("finalize-merge", "delegates repository merge"),
  new FlowArtifactNoArtifactClassification("task-impl", "changes repository source; task authority remains spec.json.tasks[]"),
]);

const FLOW_ARTIFACT_CONTRACT_LIST = Object.freeze([
  // Roots retain their authoritative names.  Every other permanent output is
  // owned by its producing step; independent deliverables live in artifacts/.
  contract("flow.state", "flow.json", "flow-state", "repository-metadata", "system", own(["system", "prepare-spec"], ["system", ...NORMAL_FLOW_STEP_ACTORS], NORMAL_FLOW_STEP_ACTORS)),
  contract("flow.activities", "activities.jsonl", "activity-ledger", "canonical-flow-artifacts", "system", own(["system", "prepare-spec"], FLOW_WIDE_RECORD_ACTORS, FLOW_WIDE_RECORD_ACTORS)),
  contract("spec.record", "spec.json", "spec-record", "repository-metadata", "system", own(["prepare-spec", "spec"], ["system", "prepare-spec", "spec", "spec-repair", "approval", "implement", "task-impl"], [
    // The renderer is a Store-backed system consumer. It may regenerate an
    // ephemeral human view but never writes a second Spec authority.
    "system", "draft", "draft-questions-review", "draft-coverage-review", "draft-gate", "spec", "spec-review", "spec-triage",
    "spec-repair", "spec-gate", "approval", "test", "scenario-validity", "test-review", "test-execute",
    "test-result-review", "implement", "impl-review", "impl-triage", "impl-repair", "impl-gate", "retro", "acceptance-review", "acceptance-decision",
    "final-regression", "report", "finalize-merge", "task-impl", "task-review", "task-triage", "task-repair", "task-gate",
  ])),
  // A Spec record is the current authority. Each byte-changing publication
  // creates one immutable revision snapshot; the optional canonical review is
  // created only when that revision enters the review funnel (or a repair
  // publication explicitly carries the prior review). They are collection
  // artifacts because the revision number is part of their identity, never a
  // mutable field on the root record.
  contract("spec.snapshot", "revisions/:{revision}/spec.json", "spec-snapshot", "repository-metadata", "system", own(
    ["system", "prepare-spec", "spec", "spec-repair", "approval", "implement", "task-impl"],
    ["system", "prepare-spec", "spec", "spec-repair", "approval", "implement", "task-impl"],
    NORMAL_FLOW_STEP_ACTORS,
  ), "permanent", "collection"),
  contract("spec.review", "revisions/:{revision}/review.json", "spec-review", "canonical-flow-artifacts", "system", own(
    ["system", "spec-review", "spec-triage", "spec-repair"],
    ["system", "spec-review", "spec-triage", "spec-repair"],
    ["system", "spec-review", "spec-triage", "spec-repair", "spec-gate"],
  ), "permanent", "collection"),
  // Issue-log entries are durable facts produced by the active Flow leaf.
  // The catalog descriptor is therefore associated with that leaf's Activity
  // even when this is the first entry (there is no system-only bootstrap
  // writer outside the Activity Store).
  // Every active Flow leaf can append an issue fact.  Those writers must be
  // able to read the prior cataloged document before performing the typed
  // append, so the read contract intentionally matches the flow-wide
  // producer/updater set rather than preserving a narrower legacy consumer
  // list that made first failure diagnostics disappear.
  contract("issue.log", "issue-log.json", "issue-log", "canonical-flow-artifacts", "system", own(
    FLOW_WIDE_RECORD_ACTORS,
    FLOW_WIDE_RECORD_ACTORS,
    FLOW_WIDE_RECORD_ACTORS,
  )),
  contract("artifact.catalog", "artifact-catalog.json", "artifact-catalog", "repository-metadata", "system", own(["system", "prepare-spec"], ["system"], ["system", "prepare-spec"]), "permanent", "singleton", false),
  contract("issue.snapshot", "issue.md", "issue-snapshot", "canonical-flow-artifacts", "system", own(["system", "prepare-spec"], ["system", "prepare-spec"], ["system", "draft", "draft-questions-review", "draft-coverage-review", "draft-gate", "spec"])),
  contract("draft", "steps/draft/result.json", "draft", "canonical-flow-artifacts", "system", own("draft", [
    "system", "draft", "draft-questions-repair", "draft-refine", "draft-coverage-repair",
  ], [
    "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine",
    "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate", "spec",
  ])),
  contract("draft.questions.review", "steps/draft-questions-review/result.json", "draft-questions-review", "canonical-flow-artifacts", "draft-questions-review", own("draft-questions-review", ["draft-questions-review"], ["system", "draft-questions-triage", "draft-questions-repair", "draft-gate"])),
  contract("draft.questions.triage", "steps/draft-questions-triage/result.json", "draft-questions-triage", "canonical-flow-artifacts", "system", own("draft-questions-triage", ["system", "draft-questions-triage"], ["draft-questions-repair", "draft-refine", "draft-gate"])),
  contract("draft.questions.repair", "steps/draft-questions-repair/result.json", "draft-questions-repair", "canonical-flow-artifacts", "system", own("draft-questions-repair", ["system", "draft-questions-repair"], ["draft-refine", "draft-gate", "acceptance-review"])),
  contract("draft.coverage.review", "steps/draft-coverage-review/result.json", "draft-coverage-review", "canonical-flow-artifacts", "draft-coverage-review", own("draft-coverage-review", ["draft-coverage-review"], ["system", "draft-coverage-triage", "draft-coverage-repair", "draft-gate"])),
  contract("draft.coverage.triage", "steps/draft-coverage-triage/result.json", "draft-coverage-triage", "canonical-flow-artifacts", "system", own("draft-coverage-triage", ["system", "draft-coverage-triage"], ["draft-coverage-repair", "draft-gate"])),
  contract("draft.coverage.repair", "steps/draft-coverage-repair/result.json", "draft-coverage-repair", "canonical-flow-artifacts", "system", own("draft-coverage-repair", ["system", "draft-coverage-repair"], ["draft-gate", "acceptance-review"])),
  contract("draft.gate.source", "steps/draft-gate/source.json", "draft-gate-source", "canonical-flow-artifacts", "draft-gate", own("draft-gate", ["draft-gate"], ["draft-gate", "spec"])),
  contract("draft.gate", "steps/draft-gate/result.json", "draft-gate", "canonical-flow-artifacts", "draft-gate", own("draft-gate", ["draft-gate"], ["spec"])),
  contract("spec.gate.source", "steps/spec-gate/source.json", "spec-gate-source", "canonical-flow-artifacts", "spec-gate", own("spec-gate", ["spec-gate"], ["spec-gate", "approval"])),
  contract("spec.gate", "steps/spec-gate/result.json", "spec-gate", "canonical-flow-artifacts", "spec-gate", own("spec-gate", ["spec-gate"], ["approval"])),
  contract("scenario.validity", "steps/scenario-validity/result.json", "scenario-validity", "canonical-flow-artifacts", "scenario-validity", own("scenario-validity", ["scenario-validity"], ["test", "test-review", "implement", "acceptance-review"])),
  contract("test.review", "steps/test-review/result.json", "test-review", "canonical-flow-artifacts", "test-review", own("test-review", ["test-review"], ["system", "test", "test-review", "implement", "impl-review"])),
  contract("test.review.repair.progress", "steps/test/repair-progress.json", "test-review-repair-progress", "canonical-flow-artifacts", "test", own("test", ["test"], ["test", "scenario-validity", "test-review"])),
  contract("test.bootstrap.observation", "steps/test/bootstrap-observation.json", "test-bootstrap-observation", "canonical-flow-artifacts", "test", own("test", ["test"], ["test", "scenario-validity", "test-review"])),
  contract("test.execute", "steps/test-execute/result.json", "test-execute", "canonical-flow-artifacts", "test-execute", own("test-execute", ["test-execute"], ["test-review", "test-result-review", "impl-review", "impl-repair", "impl-gate", "task-gate", "acceptance-review", "final-regression", "retro", "report"])),
  contract("test.result.review", "steps/test-result-review/result.json", "test-result-review", "canonical-flow-artifacts", "test-result-review", own("test-result-review", ["test-result-review"], ["test-review", "impl-review", "impl-repair", "impl-gate", "task-gate", "acceptance-review", "final-regression", "retro", "report"])),
  contract("impl.review", "steps/impl/review/result.json", "impl-review", "canonical-flow-artifacts", "impl-review", own("impl-review", ["impl-review"], ["system", "impl-triage", "impl-repair", "impl-gate", "acceptance-review"])),
  contract("impl.triage", "steps/impl/triage/result.json", "impl-triage", "execution-checkout", "impl-triage", own("impl-triage", ["impl-triage"], ["impl-repair", "impl-gate", "acceptance-review"])),
  contract("impl.repair", "steps/impl/repair/result.json", "impl-repair", "execution-checkout", "impl-repair", own("impl-repair", ["impl-repair"], ["system", "test-execute", "impl-gate", "acceptance-review"])),
  contract("impl.gate.source", "steps/impl/gate/source.json", "impl-gate-source", "canonical-flow-artifacts", "impl-gate", own("impl-gate", ["impl-gate"], ["impl-gate", "retro"])),
  contract("impl.gate", "steps/impl/gate/result.json", "impl-gate", "canonical-flow-artifacts", "impl-gate", own("impl-gate", ["impl-gate"], ["retro", "acceptance-review", "final-regression", "report"])),
  contract("retro", "steps/impl/retro/result.json", "retro", "canonical-flow-artifacts", "retro", own("retro", ["retro"], ["acceptance-review", "report"])),
  contract("acceptance.review", "steps/acceptance-review/result.json", "acceptance-review", "canonical-flow-artifacts", "acceptance-review", own("acceptance-review", ["acceptance-review"], ["impl-triage", "acceptance-decision", "final-regression", "report"])),
  contract("acceptance.review.evidence", "steps/acceptance-review/dispositions.json", "acceptance-review-evidence", "canonical-flow-artifacts", "acceptance-review", own("acceptance-review", ["acceptance-review"], ["acceptance-review", "final-regression"])),
  contract("acceptance.decision", "steps/acceptance-decision/result.json", "acceptance-decision", "canonical-flow-artifacts", "acceptance-decision", own("acceptance-decision", ["acceptance-decision"], ["final-regression", "report"])),
  contract("final.regression", "steps/final-regression/result.json", "final-regression", "canonical-flow-artifacts", "final-regression", own("final-regression", ["final-regression"], ["final-regression", "system", "report"])),
  // A linked-Issue report delivery can crash after its pending report is
  // journaled but before the external idempotency receipt is observed.  The
  // report producer must therefore be able to re-read its own cataloged
  // document during the exact outbox recovery; it still cannot infer a path
  // or bypass the catalog.
  contract("report", "artifacts/report.json", "report", "canonical-flow-artifacts", "report", own("report", ["report"], ["report", "finalize-commit", "finalize-sync", "finalize-cleanup"])),
  contract("ideas", "artifacts/ideas.json", "ideas", "canonical-flow-artifacts", "retro", own("retro", ["retro", "finalize-sync"], ["report", "finalize-sync"])),
  // Plugin lifecycle hooks write per-plugin durable outputs beneath this
  // namespace.  Workflow ideas retain their own contract and are excluded
  // from this broader source-era pattern below.
  contract("plugin.lifecycle.artifact", "artifacts/plugin-artifacts/:{pluginArtifactPath}", "plugin-lifecycle-artifact", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "permanent", "collection"),
  contract("file.map", "steps/impl/file-map.json", "file-map", "execution-checkout", "implement", own(["implement", "task-impl"], ["implement", "impl-repair", "task-impl", "task-repair"], ["system", "implement", "impl-repair", "task-impl", "task-repair", "test-execute", "test-result-review", "impl-review", "impl-gate", "report"])),
  // upgrade.js is the actual writer; this shared progress evidence is consumed by gates and reporting.
  contract("upgrade.result", "steps/upgrade-result.json", "upgrade-result", "canonical-flow-artifacts", "system", own("system", ["system", "impl-gate"], ["impl-gate", "acceptance-review", "final-regression", "report"])),
  contract("placeholder.permission", "steps/test/permission.json", "placeholder-permission", "canonical-flow-artifacts", "system", own("test", ["system", "test"], ["scenario-validity", "test-review", "impl-gate"])),
  contract("completion.overrides", "steps/completion-overrides.json", "completion-overrides", "canonical-flow-artifacts", "system", own("system", ["system"], ["test-review", "test-result-review", "impl-review", "impl-gate", "acceptance-review", "final-regression"])),
  contract("retry.recovery", "steps/retry-recovery.json", "retry-recovery", "canonical-flow-artifacts", "system", own("system", ["system"], ["draft-gate", "spec-gate", "impl-gate", "test-review", "impl-review"])),
  contract("retry.recovery.baseline", "artifacts/retry-recovery/baselines/:{routeId}/:{attemptId}.json", "retry-recovery-baseline", "canonical-flow-artifacts", "system", own(["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"], ["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"], ["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"]), "permanent", "collection"),
  contract("retry.recovery.receipt", "artifacts/retry-recovery/receipts/:{routeId}/:{attemptId}.json", "retry-recovery-receipt", "canonical-flow-artifacts", "system", own(["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"], ["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"], ["system", "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review", "draft-gate", "spec-gate", "task-gate", "impl-gate"]), "permanent", "collection"),
  contract("task.review.unsealed.checkpoint", "steps/impl/:{taskId}/review/recovery/unsealed/:{attemptId}.json", "task-review-unsealed-checkpoint", "canonical-flow-artifacts", "task-review", own("task-review", ["task-review"], ["task-review"]), "permanent", "collection"),
  contract("task.review.recovery.authorization", "steps/impl/:{taskId}/review/recovery/authorizations/:{attemptId}.json", "task-review-recovery-authorization", "canonical-flow-artifacts", "task-review", own("task-review", ["task-review"], ["task-review"]), "permanent", "collection"),
  contract("task.review.reconciliation", "steps/impl/:{taskId}/review/recovery/reconciliations/:{attemptId}.json", "task-review-reconciliation", "canonical-flow-artifacts", "task-review", own("task-review", ["task-review"], ["task-review"]), "permanent", "collection"),
  contract("task.review.aborted.work-unit", "steps/impl/:{taskId}/review/recovery/aborted/:{attemptId}.json", "task-review-aborted-work-unit", "canonical-flow-artifacts", "task-review", own("task-review", ["task-review"], ["task-review"]), "permanent", "collection"),
  contract("gate.memory", "steps/impl/gate/memory.json", "gate-memory", "canonical-flow-artifacts", "impl-gate", own("impl-gate", ["impl-gate"], ["impl-gate", "final-regression"])),
  contract("repair.fingerprint", "steps/impl/repair/fingerprint.json", "repair-fingerprint", "canonical-flow-artifacts", "impl-repair", own("impl-repair", ["impl-repair"], ["test-execute", "impl-gate"])),
  contract("repair.delta", "steps/impl/repair/deltas/:{deltaId}.json", "repair-delta", "canonical-flow-artifacts", "impl-repair", own("impl-repair", ["impl-repair"], ["test-execute", "impl-gate"]), "permanent", "collection"),
  contract("repair.migration", "steps/impl/repair/migration.json", "repair-migration", "canonical-flow-artifacts", "impl-repair", own("impl-repair", ["impl-repair"], ["test-execute", "impl-gate"])),
  contract("task.triage", "steps/impl/:{taskId}/triage/result.json", "task-triage", "execution-checkout", "task-triage", own("task-triage", ["task-triage"], ["system", "task-repair", "task-gate", "acceptance-review"]), "permanent", "collection"),
  contract("task.repair", "steps/impl/:{taskId}/repair/result.json", "task-repair", "execution-checkout", "task-repair", own("task-repair", ["task-repair"], ["system", "task-review", "task-triage", "task-repair", "task-gate", "acceptance-review"]), "permanent", "collection"),
  contract("task.triage.source.handoff.baseline", "steps/impl/:{taskId}/triage/recovery/source-baselines/:{attemptId}.json", "task-triage-source-handoff-baseline", "canonical-flow-artifacts", "task-triage", own("task-triage", ["task-triage"], ["task-triage"]), "permanent", "collection"),
  contract("task.repair.source.handoff.baseline", "steps/impl/:{taskId}/repair/recovery/source-baselines/:{attemptId}.json", "task-repair-source-handoff-baseline", "canonical-flow-artifacts", "task-repair", own("task-repair", ["task-repair"], ["task-repair"]), "permanent", "collection"),
  contract("task.review", "steps/impl/:{taskId}/review/result.json", "task-review", "canonical-flow-artifacts", "task-review", own("task-review", ["task-review"], ["system", "task-triage", "task-repair", "task-gate", "acceptance-review"]), "permanent", "collection"),
  contract("task.gate.source", "steps/impl/:{taskId}/gate/source.json", "task-gate-source", "canonical-flow-artifacts", "task-gate", own("task-gate", ["task-gate"], ["task-gate"]), "permanent", "collection"),
  contract("task.gate", "steps/impl/:{taskId}/gate/result.json", "task-gate", "canonical-flow-artifacts", "task-gate", own("task-gate", ["task-gate"], ["task-impl", "implement"]), "permanent", "collection"),
  contract("task.mutation.lineage", "steps/impl/:{taskId}/impl/mutation-lineage/:{attemptId}.json", "task-mutation-lineage", "canonical-flow-artifacts", "task-impl", own(["task-impl", "task-repair"], ["task-impl", "task-repair"], ["task-review", "task-triage", "task-repair", "task-gate"]), "permanent", "collection"),
  contract("review.evidence", "steps/:{ownerPath}/evidence/:{digest}.json", "review-evidence", "canonical-flow-artifacts", "impl-review", own(
    ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"],
    ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"],
    [
      "draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review",
      "draft-questions-triage", "draft-questions-repair", "draft-coverage-triage", "draft-coverage-repair", "draft-gate",
      "spec-triage", "spec-repair", "spec-gate", "impl-triage", "impl-repair", "impl-gate", "task-gate", "acceptance-review",
    ],
  ), "permanent", "collection"),
  // Immutable observations are not review-specific.  Their typed owner path
  // follows the actual Activity node, including `flow`'s system owner and
  // task-local impl/review/gate leaves, so catalog provenance remains
  // verifiable without manufacturing a Step.
  contract("activity.evidence", "steps/:{ownerPath}/activity-evidence/:{digest}.json", "activity-evidence", "canonical-flow-artifacts", "system", own(
    FLOW_WIDE_RECORD_ACTORS,
    FLOW_WIDE_RECORD_ACTORS,
    FLOW_WIDE_RECORD_ACTORS,
  ), "permanent", "collection"),
  contract("tests.source", "artifacts/tests/:{testPath}", "test-source", "canonical-flow-artifacts", "system", own("test", ["system", "test"], ["test", "scenario-validity", "test-review", "implement", "test-execute", "final-regression"]), "permanent", "collection"),
  contract("flow.findings", "steps/flow-findings.json", "flow-findings", "canonical-flow-artifacts", "impl-review", own(
    FLOW_FINDING_SOURCE_ACTORS,
    [...FLOW_FINDING_SOURCE_ACTORS, "acceptance-review"],
    ["system", ...FLOW_FINDING_SOURCE_ACTORS, "acceptance-review", "final-regression"],
  )),
  contract("nonblocking.handoffs", "steps/nonblocking-handoffs.json", "nonblocking-handoffs", "canonical-flow-artifacts", "scenario-validity", own(
    NONBLOCKING_HANDOFF_SOURCE_ACTORS,
    NONBLOCKING_HANDOFF_SOURCE_ACTORS,
    [...NONBLOCKING_HANDOFF_SOURCE_ACTORS, "acceptance-review"],
  )),
  // Transient records are non-cataloged. Transactions and worker state are
  // runtime-only; execution logs remain next to the step that produced them.
  contract("scenario.validity.raw-log", "steps/scenario-validity/output.log", "scenario-validity-log", "canonical-flow-artifacts", "scenario-validity", own("scenario-validity", ["scenario-validity"], ["scenario-validity", "acceptance-review"]), "transient", "singleton", false),
  contract("test.execute.raw-log", "steps/test-execute/output.log", "test-execute-log", "canonical-flow-artifacts", "test-execute", own("test-execute", ["test-execute"], ["test-execute", "test-result-review", "impl-gate"]), "transient", "singleton", false),
  contract("final.regression.raw-log", "steps/final-regression/attempt-:{attempt}.log", "final-regression-log", "canonical-flow-artifacts", "final-regression", own("final-regression", ["final-regression"], ["final-regression"]), "transient", "collection", false),
  contract("retry.recovery.transaction", ".runtime/retry-recovery/transaction.json", "retry-recovery-transaction", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("impl.repair.transaction", ".runtime/impl/repair/transaction.json", "impl-repair-transaction", "execution-checkout", "impl-repair", own("impl-repair", ["impl-repair"], ["impl-repair"]), "transient", "singleton", false),
  contract("test.requirement.summary", ".runtime/test-execute/requirement-summary.json", "test-requirement-summary", "canonical-flow-artifacts", "test-execute", own("test-execute", ["test-execute"], ["test-execute"]), "transient", "singleton", false),
  // Provider output is an untrusted, disposable work unit for every review
  // leaf. The immutable evidence and attempts[] result are promoted later by
  // the owning review Activity; this runtime surface is never authority.
  contract("review.work.unit", ".runtime/review-work-units/:{workUnitPath}", "review-work-unit", "canonical-flow-artifacts", "impl-review", own(
    ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"],
    ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"],
    ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"],
  ), "transient", "collection", false),
  // Dispatcher metadata is diagnostic-only and stays below the Version
  // runtime root.  A node-id parameter makes the placement explicit without
  // creating root-level per-step runtime fields in flow.json.
  contract("runtime.step-metadata", ".runtime/step-metadata/:{stepId}.json", "step-runtime-metadata", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
  // Finalize cleanup persists the three user-visible durable surfaces; its
  // journal and command log are recovery diagnostics and stay non-cataloged.
  contract("finalize.cleanup.agent-metrics", "steps/finalize-cleanup/agent-metrics.json", "finalize-cleanup-agent-metrics", "canonical-flow-artifacts", "finalize-cleanup", own("finalize-cleanup", ["finalize-cleanup"], ["finalize-cleanup"])),
  contract("finalize.cleanup.notes", "steps/finalize-cleanup/notes.json", "finalize-cleanup-notes", "canonical-flow-artifacts", "finalize-cleanup", own("finalize-cleanup", ["finalize-cleanup"], ["finalize-cleanup"])),
  contract("finalize.cleanup.plugin-artifacts", "steps/finalize-cleanup/plugin-artifacts.json", "finalize-cleanup-plugin-artifacts", "canonical-flow-artifacts", "finalize-cleanup", own("finalize-cleanup", ["finalize-cleanup"], ["finalize-cleanup"])),
  contract("finalize.cleanup.runtime-log", ".runtime/finalize-cleanup/runtime-log.json", "finalize-cleanup-runtime-log", "canonical-flow-artifacts", "finalize-cleanup", own("finalize-cleanup", ["finalize-cleanup"], ["finalize-cleanup"]), "transient", "singleton", false),
  contract("finalize.cleanup.journal", ".runtime/finalize-cleanup/journal.json", "finalize-cleanup-journal", "canonical-flow-artifacts", "finalize-cleanup", own("finalize-cleanup", ["finalize-cleanup"], ["finalize-cleanup"]), "transient", "singleton", false),
  // Locks are operational state, never catalog content.  These typed paths
  // keep source-era root lock files out of snapshots and migration payloads.
  contract("runtime.lock.issue-log", ".runtime/locks/issue-log.lock", "issue-log-lock", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("runtime.lock.current-flow-state", ".runtime/locks/current-flow-state.lock", "current-flow-state-lock", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("runtime.lock.artifact-catalog", ".runtime/locks/artifact-catalog.lock", "artifact-catalog-lock", "repository-metadata", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("runtime.lock.retry-recovery", ".runtime/locks/retry-recovery.lock", "retry-recovery-lock", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("runtime.lock.flow-state-writer", ".runtime/locks/flow-state-writer.lock", "flow-state-writer-lock", "repository-metadata", "system", own("system", ["system"], ["system"]), "transient", "singleton", false),
  contract("runtime.lock.flow-state-writer-owner", ".runtime/locks/flow-state-writer/:{ownerToken}.owner.tmp", "flow-state-writer-owner", "repository-metadata", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
  contract("runtime.lock.impl-repair", ".runtime/locks/impl-repair/:{lockPath}", "impl-repair-lock", "execution-checkout", "impl-repair", own("impl-repair", ["impl-repair"], ["impl-repair"]), "transient", "collection", false),
  contract("runtime.lock.issue-log-owner", ".runtime/locks/issue-log/:{ownerToken}.owner.tmp", "issue-log-lock-owner", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
  contract("runtime.lock.current-flow-state-owner", ".runtime/locks/current-flow-state/:{ownerToken}.owner.tmp", "current-flow-state-lock-owner", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
  contract("runtime.lock.artifact-catalog-owner", ".runtime/locks/artifact-catalog/:{ownerToken}.owner.tmp", "artifact-catalog-lock-owner", "repository-metadata", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
  contract("runtime.lock.retry-recovery-owner", ".runtime/locks/retry-recovery/:{ownerToken}.owner.tmp", "retry-recovery-lock-owner", "canonical-flow-artifacts", "system", own("system", ["system"], ["system"]), "transient", "collection", false),
]);

const target = (logicalKey, legacyPaths, canonicalPath, producer, consumer) => new FlowArtifactSwitchTarget({
  logicalKey, legacyPaths, canonicalPath, action: "switch", producer, consumer,
});
const patternTarget = (logicalKey, legacyPatterns, canonicalPath, producer, consumer) => new FlowArtifactSwitchTarget({
  logicalKey, legacyPatterns, canonicalPath, action: "switch", producer, consumer,
});
const newTarget = (logicalKey, canonicalPath, producer, consumer) => new FlowArtifactSwitchTarget({
  logicalKey, canonicalPath, action: "new", producer, consumer,
});
const removeTarget = (logicalKey, legacyPaths = [], legacyPatterns = [], producer = "system", consumer = "system") => new FlowArtifactSwitchTarget({
  logicalKey, legacyPaths, legacyPatterns, action: "remove", producer, consumer,
});

export const FLOW_ARTIFACT_SWITCH_TARGETS = Object.freeze([
  target("flow.state", ["flow.json"], "flow.json", "prepare-spec", "prepare-spec"),
  newTarget("flow.activities", "activities.jsonl", "prepare-spec", "prepare-spec"),
  target("spec.record", ["spec.json"], "spec.json", "prepare-spec", "spec"),
  newTarget("spec.snapshot", "revisions/:{revision}/spec.json", "prepare-spec", "spec"),
  newTarget("spec.review", "revisions/:{revision}/review.json", "system", "spec-review"),
  target("issue.log", ["issue-log.json", "redolog.json"], "issue-log.json", "prepare-spec", "impl-gate"),
  newTarget("artifact.catalog", "artifact-catalog.json", "prepare-spec", "prepare-spec"),
  target("issue.snapshot", ["issue.md"], "issue.md", "prepare-spec", "draft"),
  target("draft", ["draft.json"], "steps/draft/result.json", "draft", "draft-questions-review"),
  target("draft.questions.review", ["draft-review-questions.json"], "steps/draft-questions-review/result.json", "draft-questions-review", "draft-questions-triage"),
  target("draft.questions.triage", ["draft-questions-triage.json"], "steps/draft-questions-triage/result.json", "draft-questions-triage", "draft-questions-repair"),
  target("draft.questions.repair", ["draft-questions-repair.json"], "steps/draft-questions-repair/result.json", "draft-questions-repair", "draft-refine"),
  target("draft.coverage.review", ["draft-review-coverage.json"], "steps/draft-coverage-review/result.json", "draft-coverage-review", "draft-coverage-triage"),
  target("draft.coverage.triage", ["draft-coverage-triage.json"], "steps/draft-coverage-triage/result.json", "draft-coverage-triage", "draft-coverage-repair"),
  target("draft.coverage.repair", ["draft-coverage-repair.json"], "steps/draft-coverage-repair/result.json", "draft-coverage-repair", "draft-gate"),
  target("draft.gate.source", ["draft-gate-source.json"], "steps/draft-gate/source.json", "draft-gate", "draft-gate"),
  target("draft.gate", ["draft-gate-result.json"], "steps/draft-gate/result.json", "draft-gate", "spec"),
  target("spec.gate.source", ["spec-gate-source.json"], "steps/spec-gate/source.json", "spec-gate", "spec-gate"),
  target("spec.gate", ["spec-gate-result.json"], "steps/spec-gate/result.json", "spec-gate", "approval"),
  target("scenario.validity", ["scenario-validity-result.json"], "steps/scenario-validity/result.json", "scenario-validity", "test-review"),
  target("test.review", ["test-review.json", "test-coverage.json"], "steps/test-review/result.json", "test-review", "implement"),
  newTarget("test.review.repair.progress", "steps/test/repair-progress.json", "test", "test"),
  newTarget("test.bootstrap.observation", "steps/test/bootstrap-observation.json", "test", "test"),
  target("test.execute", ["test-execute-result.json"], "steps/test-execute/result.json", "test-execute", "test-result-review"),
  target("test.result.review", ["test-result-review.json"], "steps/test-result-review/result.json", "test-result-review", "impl-review"),
  target("impl.review", ["impl-review.json"], "steps/impl/review/result.json", "impl-review", "impl-triage"),
  target("impl.triage", ["impl-triage.json"], "steps/impl/triage/result.json", "impl-triage", "impl-repair"),
  target("impl.repair", ["impl-repair.json"], "steps/impl/repair/result.json", "impl-repair", "test-execute"),
  target("impl.gate.source", ["impl-gate-source.json"], "steps/impl/gate/source.json", "impl-gate", "impl-gate"),
  target("impl.gate", ["impl-gate-result.json"], "steps/impl/gate/result.json", "impl-gate", "retro"),
  target("retro", ["retro.json"], "steps/impl/retro/result.json", "retro", "acceptance-review"),
  target("acceptance.review", ["acceptance-review.json"], "steps/acceptance-review/result.json", "acceptance-review", "final-regression"),
  target("acceptance.review.evidence", ["acceptance-review-evidence.json"], "steps/acceptance-review/dispositions.json", "acceptance-review", "acceptance-review"),
  newTarget("acceptance.decision", "steps/acceptance-decision/result.json", "acceptance-decision", "final-regression"),
  target("final.regression", ["final-regression-result.json"], "steps/final-regression/result.json", "final-regression", "report"),
  target("report", ["report.json"], "artifacts/report.json", "report", "finalize-commit"),
  target("ideas", ["ideas.json", "plugin-artifacts/workflow/ideas.json"], "artifacts/ideas.json", "retro", "finalize-sync"),
  patternTarget("plugin.lifecycle.artifact", [new FlowArtifactLegacyPattern("plugin-artifacts/:{pluginArtifactPath}", { excludedPrefixes: ["plugin-artifacts/workflow/ideas.json"] })], "artifacts/plugin-artifacts/:{pluginArtifactPath}", "system", "system"),
  target("file.map", ["file-map.json"], "steps/impl/file-map.json", "implement", "impl-review"),
  target("upgrade.result", ["upgrade-result.json"], "steps/upgrade-result.json", "system", "impl-gate"),
  target("placeholder.permission", ["placeholder-permission.json"], "steps/test/permission.json", "test", "test-review"),
  target("completion.overrides", ["completion-overrides.json"], "steps/completion-overrides.json", "system", "impl-gate"),
  target("retry.recovery", ["retry-recovery.json"], "steps/retry-recovery.json", "system", "impl-gate"),
  newTarget("retry.recovery.baseline", "artifacts/retry-recovery/baselines/:{routeId}/:{attemptId}.json", "system", "system"),
  newTarget("retry.recovery.receipt", "artifacts/retry-recovery/receipts/:{routeId}/:{attemptId}.json", "system", "system"),
  newTarget("task.review.unsealed.checkpoint", "steps/impl/:{taskId}/review/recovery/unsealed/:{attemptId}.json", "task-review", "task-review"),
  newTarget("task.review.recovery.authorization", "steps/impl/:{taskId}/review/recovery/authorizations/:{attemptId}.json", "task-review", "task-review"),
  newTarget("task.review.reconciliation", "steps/impl/:{taskId}/review/recovery/reconciliations/:{attemptId}.json", "task-review", "task-review"),
  newTarget("task.review.aborted.work-unit", "steps/impl/:{taskId}/review/recovery/aborted/:{attemptId}.json", "task-review", "task-review"),
  target("gate.memory", ["gate-impl-memory.json"], "steps/impl/gate/memory.json", "impl-gate", "impl-gate"),
  target("repair.fingerprint", ["repair-fingerprint.json"], "steps/impl/repair/fingerprint.json", "impl-repair", "test-execute"),
  patternTarget("repair.delta", ["repair-deltas/:{deltaId}.json"], "steps/impl/repair/deltas/:{deltaId}.json", "impl-repair", "test-execute"),
  target("repair.migration", ["repair-state-migration.json"], "steps/impl/repair/migration.json", "impl-repair", "impl-gate"),
  newTarget("task.triage", "steps/impl/:{taskId}/triage/result.json", "task-triage", "task-repair"),
  newTarget("task.repair", "steps/impl/:{taskId}/repair/result.json", "task-repair", "task-review"),
  newTarget("task.triage.source.handoff.baseline", "steps/impl/:{taskId}/triage/recovery/source-baselines/:{attemptId}.json", "task-triage", "task-triage"),
  newTarget("task.repair.source.handoff.baseline", "steps/impl/:{taskId}/repair/recovery/source-baselines/:{attemptId}.json", "task-repair", "task-repair"),
  newTarget("task.review", "steps/impl/:{taskId}/review/result.json", "task-review", "task-gate"),
  target("task.gate.source", ["task-impl-gate-source.json"], "steps/impl/:{taskId}/gate/source.json", "task-gate", "task-gate"),
  target("task.gate", ["task-impl-gate-result.json"], "steps/impl/:{taskId}/gate/result.json", "task-gate", "task-impl"),
  newTarget("task.mutation.lineage", "steps/impl/:{taskId}/impl/mutation-lineage/:{attemptId}.json", "task-impl", "task-review"),
  patternTarget("review.evidence", ["review-evidence/:{digest}.json"], "steps/:{ownerPath}/evidence/:{digest}.json", "impl-review", "impl-gate"),
  newTarget("activity.evidence", "steps/:{ownerPath}/activity-evidence/:{digest}.json", "system", "system"),
  patternTarget("tests.source", [new FlowArtifactLegacyPattern("tests/:{testPath}", { excludedPrefixes: ["tests/.raw/"] })], "artifacts/tests/:{testPath}", "test", "test-review"),
  target("flow.findings", ["flow-findings.json"], "steps/flow-findings.json", "impl-review", "impl-gate"),
  target("nonblocking.handoffs", ["nonblocking-handoffs.json"], "steps/nonblocking-handoffs.json", "scenario-validity", "acceptance-review"),
  target("scenario.validity.raw-log", ["tests/.raw/scenario-validity.log"], "steps/scenario-validity/output.log", "scenario-validity", "scenario-validity"),
  target("test.execute.raw-log", ["tests/.raw/test-execution.log"], "steps/test-execute/output.log", "test-execute", "test-execute"),
  patternTarget("final.regression.raw-log", ["tests/.raw/final-regression-attempt-:{attempt}.log"], "steps/final-regression/attempt-:{attempt}.log", "final-regression", "final-regression"),
  target("retry.recovery.transaction", [".retry-recovery.transaction.json"], ".runtime/retry-recovery/transaction.json", "system", "system"),
  target("impl.repair.transaction", ["impl-repair-transaction.json"], ".runtime/impl/repair/transaction.json", "impl-repair", "impl-repair"),
  target("test.requirement.summary", ["tests/.raw/requirement-summary.json"], ".runtime/test-execute/requirement-summary.json", "test-execute", "test-execute"),
  patternTarget("review.work.unit", ["review-history/work-units/:{workUnitPath}"], ".runtime/review-work-units/:{workUnitPath}", "impl-review", "impl-review"),
  newTarget("runtime.step-metadata", ".runtime/step-metadata/:{stepId}.json", "system", "system"),
  target("finalize.cleanup.agent-metrics", ["agent-metrics.json"], "steps/finalize-cleanup/agent-metrics.json", "finalize-cleanup", "finalize-cleanup"),
  target("finalize.cleanup.notes", ["notes.json"], "steps/finalize-cleanup/notes.json", "finalize-cleanup", "finalize-cleanup"),
  target("finalize.cleanup.plugin-artifacts", ["plugin-artifacts.json"], "steps/finalize-cleanup/plugin-artifacts.json", "finalize-cleanup", "finalize-cleanup"),
  target("finalize.cleanup.runtime-log", ["runtime-log.json"], ".runtime/finalize-cleanup/runtime-log.json", "finalize-cleanup", "finalize-cleanup"),
  target("finalize.cleanup.journal", ["finalize-cleanup.json"], ".runtime/finalize-cleanup/journal.json", "finalize-cleanup", "finalize-cleanup"),
  target("runtime.lock.issue-log", [".issue-log.lock"], ".runtime/locks/issue-log.lock", "system", "system"),
  target("runtime.lock.current-flow-state", [".current-flow-state.lock"], ".runtime/locks/current-flow-state.lock", "system", "system"),
  target("runtime.lock.artifact-catalog", [".artifact-catalog.lock"], ".runtime/locks/artifact-catalog.lock", "system", "system"),
  target("runtime.lock.retry-recovery", [".retry-recovery.lock"], ".runtime/locks/retry-recovery.lock", "system", "system"),
  target("runtime.lock.flow-state-writer", [".flow.json.writer.lock"], ".runtime/locks/flow-state-writer.lock", "system", "system"),
  patternTarget("runtime.lock.flow-state-writer-owner", [".flow.json.writer.:{ownerToken}.owner.tmp"], ".runtime/locks/flow-state-writer/:{ownerToken}.owner.tmp", "system", "system"),
  patternTarget("runtime.lock.impl-repair", [".impl-repair.lock/:{lockPath}"], ".runtime/locks/impl-repair/:{lockPath}", "impl-repair", "impl-repair"),
  patternTarget("runtime.lock.issue-log-owner", ["..issue-log.lock.:{ownerToken}.owner.tmp"], ".runtime/locks/issue-log/:{ownerToken}.owner.tmp", "system", "system"),
  patternTarget("runtime.lock.current-flow-state-owner", ["..current-flow-state.lock.:{ownerToken}.owner.tmp"], ".runtime/locks/current-flow-state/:{ownerToken}.owner.tmp", "system", "system"),
  patternTarget("runtime.lock.artifact-catalog-owner", ["..artifact-catalog.lock.:{ownerToken}.owner.tmp"], ".runtime/locks/artifact-catalog/:{ownerToken}.owner.tmp", "system", "system"),
  patternTarget("runtime.lock.retry-recovery-owner", ["..retry-recovery.lock.:{ownerToken}.owner.tmp"], ".runtime/locks/retry-recovery/:{ownerToken}.owner.tmp", "system", "system"),
  removeTarget("legacy.flow.version", ["flow-version.json"]),
  removeTarget("legacy.activity.view", ["activities.md"]),
  removeTarget("legacy.derived.views", ["draft.md", "draft-review.md", "draft-review-questions.md", "draft-review-coverage.md", "spec.md", "spec-review.md", "test.md", "test-review.md", "test-result-review.md", "review.md", "qa.md"]),
  removeTarget("legacy.task.views", [], ["tasks/:{taskView}.md"]),
  removeTarget("legacy.derived.review.artifacts", ["draft-review-questions-repair.json", "spec-review-triage.json"]),
  removeTarget("legacy.review.history", [], [new FlowArtifactLegacyPattern("review-history/:{historyPath}", { excludedPrefixes: ["review-history/work-units/"] })]),
  removeTarget("legacy.finalize.envelopes", ["report-envelope.json", "recovery-envelope.json"], [], "finalize-cleanup", "finalize-cleanup"),
  removeTarget("legacy.raw.logs", ["tests/.raw/final-regression.log"]),
]);

const known = (logicalKey, action, legacyPath) => new FlowArtifactKnownFile({ logicalKey, action, legacyPath });
const knownPattern = (logicalKey, action, legacyPattern) => new FlowArtifactKnownFile({ logicalKey, action, legacyPattern });
const knownNew = (logicalKey, canonicalPath) => new FlowArtifactKnownFile({ logicalKey, action: "new", canonicalPath });

export const FLOW_ARTIFACT_NORMAL_FLOW_FILES = Object.freeze([
  known("flow.state", "switch", "flow.json"), knownNew("flow.activities", "activities.jsonl"),
  known("spec.record", "switch", "spec.json"), known("issue.log", "switch", "issue-log.json"), known("issue.log", "switch", "redolog.json"),
  knownNew("spec.snapshot", "revisions/:{revision}/spec.json"), knownNew("spec.review", "revisions/:{revision}/review.json"),
  knownNew("artifact.catalog", "artifact-catalog.json"), known("issue.snapshot", "switch", "issue.md"),
  known("draft", "switch", "draft.json"), known("draft.questions.review", "switch", "draft-review-questions.json"),
  known("draft.questions.triage", "switch", "draft-questions-triage.json"), known("draft.questions.repair", "switch", "draft-questions-repair.json"),
  known("draft.coverage.review", "switch", "draft-review-coverage.json"), known("draft.coverage.triage", "switch", "draft-coverage-triage.json"), known("draft.coverage.repair", "switch", "draft-coverage-repair.json"),
  known("draft.gate.source", "switch", "draft-gate-source.json"), known("draft.gate", "switch", "draft-gate-result.json"),
  known("spec.gate.source", "switch", "spec-gate-source.json"), known("spec.gate", "switch", "spec-gate-result.json"),
  known("scenario.validity", "switch", "scenario-validity-result.json"), known("test.review", "switch", "test-review.json"), known("test.review", "switch", "test-coverage.json"), knownNew("test.review.repair.progress", "steps/test/repair-progress.json"), knownNew("test.bootstrap.observation", "steps/test/bootstrap-observation.json"), known("test.execute", "switch", "test-execute-result.json"), known("test.result.review", "switch", "test-result-review.json"),
  known("impl.review", "switch", "impl-review.json"), known("impl.triage", "switch", "impl-triage.json"), known("impl.repair", "switch", "impl-repair.json"), known("impl.gate.source", "switch", "impl-gate-source.json"), known("impl.gate", "switch", "impl-gate-result.json"), known("retro", "switch", "retro.json"),
  known("acceptance.review", "switch", "acceptance-review.json"), known("acceptance.review.evidence", "switch", "acceptance-review-evidence.json"), knownNew("acceptance.decision", "steps/acceptance-decision/result.json"), known("final.regression", "switch", "final-regression-result.json"), known("report", "switch", "report.json"), known("ideas", "switch", "ideas.json"), known("ideas", "switch", "plugin-artifacts/workflow/ideas.json"), knownPattern("plugin.lifecycle.artifact", "switch", new FlowArtifactLegacyPattern("plugin-artifacts/:{pluginArtifactPath}", { excludedPrefixes: ["plugin-artifacts/workflow/ideas.json"] })), known("file.map", "switch", "file-map.json"),
  known("upgrade.result", "switch", "upgrade-result.json"), known("placeholder.permission", "switch", "placeholder-permission.json"), known("completion.overrides", "switch", "completion-overrides.json"), known("retry.recovery", "switch", "retry-recovery.json"), knownNew("retry.recovery.baseline", "artifacts/retry-recovery/baselines/:{routeId}/:{attemptId}.json"), knownNew("retry.recovery.receipt", "artifacts/retry-recovery/receipts/:{routeId}/:{attemptId}.json"), knownNew("task.review.unsealed.checkpoint", "steps/impl/:{taskId}/review/recovery/unsealed/:{attemptId}.json"), knownNew("task.review.recovery.authorization", "steps/impl/:{taskId}/review/recovery/authorizations/:{attemptId}.json"), known("gate.memory", "switch", "gate-impl-memory.json"),
  known("repair.fingerprint", "switch", "repair-fingerprint.json"), knownPattern("repair.delta", "switch", "repair-deltas/:{deltaId}.json"), known("repair.migration", "switch", "repair-state-migration.json"), known("impl.repair.transaction", "switch", "impl-repair-transaction.json"), knownNew("task.review", "steps/impl/:{taskId}/review/result.json"), knownNew("task.triage", "steps/impl/:{taskId}/triage/result.json"), knownNew("task.repair", "steps/impl/:{taskId}/repair/result.json"), knownNew("task.triage.source.handoff.baseline", "steps/impl/:{taskId}/triage/recovery/source-baselines/:{attemptId}.json"), knownNew("task.repair.source.handoff.baseline", "steps/impl/:{taskId}/repair/recovery/source-baselines/:{attemptId}.json"),
  known("task.gate.source", "switch", "task-impl-gate-source.json"), known("task.gate", "switch", "task-impl-gate-result.json"), knownNew("task.mutation.lineage", "steps/impl/:{taskId}/impl/mutation-lineage/:{attemptId}.json"), knownPattern("review.evidence", "switch", "review-evidence/:{digest}.json"), knownPattern("tests.source", "switch", new FlowArtifactLegacyPattern("tests/:{testPath}", { excludedPrefixes: ["tests/.raw/"] })),
  knownNew("activity.evidence", "steps/:{ownerPath}/activity-evidence/:{digest}.json"),
  knownNew("task.review.reconciliation", "steps/impl/:{taskId}/review/recovery/reconciliations/:{attemptId}.json"), knownNew("task.review.aborted.work-unit", "steps/impl/:{taskId}/review/recovery/aborted/:{attemptId}.json"),
  known("flow.findings", "switch", "flow-findings.json"), known("nonblocking.handoffs", "switch", "nonblocking-handoffs.json"), known("scenario.validity.raw-log", "switch", "tests/.raw/scenario-validity.log"), known("test.execute.raw-log", "switch", "tests/.raw/test-execution.log"), knownPattern("final.regression.raw-log", "switch", "tests/.raw/final-regression-attempt-:{attempt}.log"), known("retry.recovery.transaction", "switch", ".retry-recovery.transaction.json"), known("test.requirement.summary", "switch", "tests/.raw/requirement-summary.json"), knownPattern("review.work.unit", "switch", "review-history/work-units/:{workUnitPath}"), knownNew("runtime.step-metadata", ".runtime/step-metadata/:{stepId}.json"),
  known("finalize.cleanup.agent-metrics", "switch", "agent-metrics.json"), known("finalize.cleanup.notes", "switch", "notes.json"), known("finalize.cleanup.plugin-artifacts", "switch", "plugin-artifacts.json"), known("finalize.cleanup.runtime-log", "switch", "runtime-log.json"), known("finalize.cleanup.journal", "switch", "finalize-cleanup.json"),
  known("runtime.lock.issue-log", "switch", ".issue-log.lock"), known("runtime.lock.current-flow-state", "switch", ".current-flow-state.lock"), known("runtime.lock.artifact-catalog", "switch", ".artifact-catalog.lock"), known("runtime.lock.retry-recovery", "switch", ".retry-recovery.lock"), known("runtime.lock.flow-state-writer", "switch", ".flow.json.writer.lock"), knownPattern("runtime.lock.flow-state-writer-owner", "switch", ".flow.json.writer.:{ownerToken}.owner.tmp"), knownPattern("runtime.lock.impl-repair", "switch", ".impl-repair.lock/:{lockPath}"),
  knownPattern("runtime.lock.issue-log-owner", "switch", "..issue-log.lock.:{ownerToken}.owner.tmp"), knownPattern("runtime.lock.current-flow-state-owner", "switch", "..current-flow-state.lock.:{ownerToken}.owner.tmp"), knownPattern("runtime.lock.artifact-catalog-owner", "switch", "..artifact-catalog.lock.:{ownerToken}.owner.tmp"), knownPattern("runtime.lock.retry-recovery-owner", "switch", "..retry-recovery.lock.:{ownerToken}.owner.tmp"),
  known("legacy.flow.version", "remove", "flow-version.json"), known("legacy.activity.view", "remove", "activities.md"), known("legacy.derived.views", "remove", "draft.md"), known("legacy.derived.views", "remove", "draft-review.md"), known("legacy.derived.views", "remove", "draft-review-questions.md"), known("legacy.derived.views", "remove", "draft-review-coverage.md"), known("legacy.derived.views", "remove", "spec.md"), known("legacy.derived.views", "remove", "spec-review.md"), known("legacy.derived.views", "remove", "test.md"), known("legacy.derived.views", "remove", "test-review.md"), known("legacy.derived.views", "remove", "test-result-review.md"), known("legacy.derived.views", "remove", "review.md"), known("legacy.derived.views", "remove", "qa.md"), knownPattern("legacy.task.views", "remove", "tasks/:{taskView}.md"), known("legacy.derived.review.artifacts", "remove", "draft-review-questions-repair.json"), known("legacy.derived.review.artifacts", "remove", "spec-review-triage.json"), knownPattern("legacy.review.history", "remove", new FlowArtifactLegacyPattern("review-history/:{historyPath}", { excludedPrefixes: ["review-history/work-units/"] })), known("legacy.finalize.envelopes", "remove", "report-envelope.json"), known("legacy.finalize.envelopes", "remove", "recovery-envelope.json"), known("legacy.raw.logs", "remove", "tests/.raw/final-regression.log"),
]);

export const FLOW_ARTIFACT_LEGACY_SWITCH_TARGETS = Object.freeze([
  new FlowArtifactLegacyTarget("flow-version.json"), new FlowArtifactLegacyTarget("artifacts"), new FlowArtifactLegacyTarget("review-evidence"),
]);

export const FLOW_ARTIFACT_CONTRACTS = new FlowArtifactRegistry({
  contracts: FLOW_ARTIFACT_CONTRACT_LIST,
  legacyTargets: FLOW_ARTIFACT_LEGACY_SWITCH_TARGETS,
  switchTargets: FLOW_ARTIFACT_SWITCH_TARGETS,
  knownFiles: FLOW_ARTIFACT_NORMAL_FLOW_FILES,
});
