/**
 * src/flow/lib/test-headers.js
 *
 * Spec-header parser, coverage evaluator, and validation for spec
 * verification test files. Replaces test-map.json (spec 249).
 *
 * Header format: `// spec: R1 R2 ...` (JS) or `# spec: R1 R2 ...` (md/yaml).
 * - JS-like extensions (.js, .mjs, .ts) reject `# spec:` as MISMATCHED_MARKER.
 * - Headers must appear before the first non-empty non-comment line.
 * - Shebang (`#!`) and license/comment lines without `spec` keyword are skipped.
 */

import fs from "node:fs";
import path from "node:path";
import { CanonicalRequirementId } from "../../lib/spec-json.js";

const SPEC_TEST_EXT_RE = /\.(test|spec)\.(js|ts|mjs)$/;
const STRICT_HEADER_RE = new RegExp(`^\\s*(//|#)\\s+spec:\\s+(${CanonicalRequirementId.patternSource}(?:\\s+${CanonicalRequirementId.patternSource})*)\\s*$`);
// Candidate detection: any line containing `spec` keyword in a comment-like prefix.
const CANDIDATE_RE = /^\s*(\/\/+|#+)\s*spec\b/;
const SHEBANG_RE = /^#!/;
const NON_COMMENT_RE = /^\s*[^\s/#]/;
const TEST_NAME_RE = new RegExp(`(it|test)\\s*\\(\\s*['\"\`]R(${CanonicalRequirementId.numberPatternSource}):`, "g");
const JS_EXTS = new Set([".js", ".mjs", ".ts"]);

function uniqueIds(ids) {
  const seen = new Set();
  const dups = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  return { unique: [...seen], duplicates: dups };
}

/**
 * Parse a single line as a header candidate.
 * @returns {{ kind: "valid", marker: string, ids: string[] } |
 *           { kind: "malformed", reason: string } |
 *           { kind: "mismatched-marker", marker: string } |
 *           { kind: "not-a-candidate" }}
 */
export function parseHeader(line, { ext, lineNumber } = {}) {
  if (!CANDIDATE_RE.test(line)) {
    return { kind: "not-a-candidate" };
  }
  const strict = STRICT_HEADER_RE.exec(line);
  if (!strict) {
    return { kind: "malformed", reason: "header does not match strict form `// spec: R1 R2 ...`", lineNumber };
  }
  const marker = strict[1];
  const ids = strict[2].split(/\s+/);
  if (marker === "#" && ext && JS_EXTS.has(ext)) {
    return { kind: "mismatched-marker", marker, expected: "//", lineNumber };
  }
  return { kind: "valid", marker, ids, lineNumber };
}

/**
 * Scan a single test file for the spec header.
 * @returns {{ kind: "valid", ids: string[], duplicateIds: string[], lineNumber: number,
 *             duplicateHeaders: Array<{ lineNumber: number }>,
 *             malformedHeaders: Array<{ lineNumber: number, raw: string, reason: string }>,
 *             mismatchedMarker: { lineNumber: number, expected: string } | null } |
 *           { kind: "missing", malformedHeaders: [...], mismatchedMarker: ..., duplicateHeaders: [...] }}
 */
export function scanFileHeader(absPath) {
  const ext = path.extname(absPath);
  const content = fs.readFileSync(absPath, "utf8");
  const lines = content.split(/\r?\n/);

  const validHeaders = [];
  const malformedHeaders = [];
  const duplicateHeaders = [];
  let mismatchedMarker = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    if (i === 0 && SHEBANG_RE.test(line)) continue;
    if (line.trim() === "") continue;
    // Stop at the first non-empty, non-comment-like line that is not a candidate.
    const isComment = /^\s*(\/\/|#)/.test(line);
    if (!isComment) break;

    const result = parseHeader(line, { ext, lineNumber });
    if (result.kind === "valid") {
      if (validHeaders.length === 0) {
        validHeaders.push(result);
      } else {
        duplicateHeaders.push({ lineNumber });
      }
    } else if (result.kind === "malformed") {
      malformedHeaders.push({ lineNumber, raw: line, reason: result.reason });
    } else if (result.kind === "mismatched-marker") {
      mismatchedMarker = { lineNumber, expected: result.expected, found: result.marker };
    }
    // not-a-candidate: regular comment, skip
  }

  if (validHeaders.length === 0) {
    return {
      kind: "missing",
      malformedHeaders,
      mismatchedMarker,
      duplicateHeaders: [],
    };
  }

  const first = validHeaders[0];
  const { unique, duplicates } = uniqueIds(first.ids);
  return {
    kind: "valid",
    ids: unique,
    duplicateIds: duplicates,
    lineNumber: first.lineNumber,
    duplicateHeaders,
    malformedHeaders,
    mismatchedMarker,
  };
}

/**
 * Recursively discover spec verification test files.
 */
export function getSpecTestFiles(specDir) {
  const testsDir = path.join(specDir, "tests");
  if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) return [];
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SPEC_TEST_EXT_RE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(testsDir);
  return out;
}

/**
 * Extract test-name requirement IDs from a file (i.e., test() / it() with an `R1:` prefix).
 */
export function extractTestNameReqIds(absPath) {
  const content = fs.readFileSync(absPath, "utf8");
  const ids = new Set();
  let m;
  TEST_NAME_RE.lastIndex = 0;
  while ((m = TEST_NAME_RE.exec(content)) !== null) {
    ids.add("R" + m[2]);
  }
  return [...ids];
}

/**
 * Build per-file header information across all spec test files.
 * @returns Map<filePath, { headerIds: string[], testNameIds: string[], scan: ReturnType<scanFileHeader> }>
 */
export function collectFileHeaders(specDir) {
  const files = getSpecTestFiles(specDir);
  const map = new Map();
  for (const file of files) {
    const scan = scanFileHeader(file);
    const headerIds = scan.kind === "valid" ? scan.ids : [];
    const testNameIds = extractTestNameReqIds(file);
    map.set(file, { headerIds, testNameIds, scan });
  }
  return map;
}

/**
 * Build a Map<reqId, Set<file>> from collectFileHeaders output.
 * Used by retro static evaluation to determine which files map to which requirements.
 */
export function buildReqToFilesMap(fileHeaders, specDir) {
  const map = new Map();
  for (const [file, info] of fileHeaders) {
    const rel = path.relative(path.join(specDir, "tests"), file);
    for (const id of info.headerIds) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(rel);
    }
  }
  return map;
}

/**
 * Validate test-headers for the test step gate.
 * @param {{ specDir: string, spec: { requirements?: Array<{id, desc, testable?}> } }} args
 * @returns canonical ValidationResult
 */
function validateHeaderFiles({ specDir, spec, coverageRequirementIds = null, selectedFileHeaders = collectFileHeaders(specDir) }) {
  const requirements = Array.isArray(spec?.requirements) ? spec.requirements : [];
  const validReqIds = new Set(requirements.map((r) => r.id));
  const testableIds = new Set(
    requirements.filter((r) => r.testable !== false).map((r) => r.id),
  );
  const nonTestableIds = new Set(
    requirements.filter((r) => r.testable === false).map((r) => r.id),
  );

  const result = {
    ok: true,
    missingHeaders: [],
    uncoveredRequirements: [],
    unknownIds: [],
    malformedHeaders: [],
    duplicateIds: [],
    duplicateHeaders: [],
    notTestableInHeader: [],
    mismatchedMarker: [],
    headerNoTest: [],
    testNoHeader: [],
  };

  const declaredIds = new Set();

  for (const [file, info] of selectedFileHeaders) {
    const rel = path.relative(specDir, file);
    const { scan } = info;
    if (scan.kind === "missing") {
      result.missingHeaders.push(rel);
    } else {
      for (const id of scan.ids) declaredIds.add(id);
      for (const id of scan.duplicateIds) {
        result.duplicateIds.push({ file: rel, id });
      }
      for (const dup of scan.duplicateHeaders) {
        result.duplicateHeaders.push({ file: rel, lineNumber: dup.lineNumber });
      }
      for (const id of scan.ids) {
        if (!validReqIds.has(id)) {
          result.unknownIds.push({ file: rel, id });
        } else if (nonTestableIds.has(id)) {
          result.notTestableInHeader.push({ file: rel, id });
        }
      }
    }
    for (const m of scan.malformedHeaders) {
      result.malformedHeaders.push({ file: rel, line: m.lineNumber, raw: m.raw, reason: m.reason });
    }
    if (scan.mismatchedMarker) {
      result.mismatchedMarker.push({ file: rel, ...scan.mismatchedMarker });
    }

    // Per-file mismatch
    const headerSet = new Set(info.headerIds);
    const testSet = new Set(info.testNameIds);
    for (const id of headerSet) {
      if (validReqIds.has(id) && !nonTestableIds.has(id) && !testSet.has(id)) {
        result.headerNoTest.push({ file: rel, id });
      }
    }
    for (const id of testSet) {
      if (validReqIds.has(id) && !headerSet.has(id)) {
        result.testNoHeader.push({ file: rel, id });
      }
    }
  }

  // Coverage: every selected testable requirement must be declared in at least one file.
  const coverageRequirements = coverageRequirementIds === null
    ? requirements
    : requirements.filter((req) => coverageRequirementIds.has(req.id));
  for (const req of coverageRequirements) {
    if (req.testable === false) continue;
    if (!declaredIds.has(req.id)) {
      result.uncoveredRequirements.push({ id: req.id, desc: req.desc });
    }
  }

  result.ok = result.missingHeaders.length === 0
    && result.uncoveredRequirements.length === 0
    && result.unknownIds.length === 0
    && result.malformedHeaders.length === 0
    && result.duplicateIds.length === 0
    && result.duplicateHeaders.length === 0
    && result.notTestableInHeader.length === 0
    && result.mismatchedMarker.length === 0
    && result.headerNoTest.length === 0
    && result.testNoHeader.length === 0;

  return result;
}

/**
 * Validate all testable requirements in a spec. This is the original global
 * validation mode; its result shape and coverage semantics are intentionally
 * unchanged.
 */
export function validateTestHeaders({ specDir, spec }) {
  return validateHeaderFiles({ specDir, spec });
}

function requiredRequirementId(value, label) {
  return new CanonicalRequirementId(value, label).toString();
}

/**
 * The result of validating a worker bundle bound to one primary Requirement.
 * Secondary Requirements are checked for normal header integrity, but never
 * contribute to primary completion.
 */
export class AssignedRequirementTestValidation {
  constructor({ assignedRequirementId, secondaryRequirementIds = [], validationResult, recoverableIssues = [], assignedCovered = false }) {
    this.assignedRequirementId = requiredRequirementId(assignedRequirementId, "assignedRequirementId");
    if (!Array.isArray(secondaryRequirementIds)
      || !secondaryRequirementIds.every((id) => CanonicalRequirementId.is(id))) {
      throw new Error("secondaryRequirementIds must contain requirement ids");
    }
    const secondary = [...new Set(secondaryRequirementIds)];
    if (secondary.includes(this.assignedRequirementId)) {
      throw new Error("secondaryRequirementIds must not contain assignedRequirementId");
    }
    if (!validationResult || typeof validationResult !== "object") {
      throw new Error("validationResult is required");
    }
    if (!Array.isArray(recoverableIssues)) {
      throw new Error("recoverableIssues must be an array");
    }
    this.secondaryRequirementIds = Object.freeze(secondary);
    this.validationResult = validationResult;
    this.recoverableIssues = Object.freeze(recoverableIssues);
    if (typeof assignedCovered !== "boolean") throw new Error("assignedCovered must be boolean");
    this.assignedCovered = assignedCovered;
    Object.freeze(this);
  }

  get ok() {
    return this.validationResult.ok && this.recoverableIssues.length === 0;
  }

  get result() {
    return this.validationResult;
  }

  get recoverableIssueCodes() {
    return this.recoverableIssues.map((issue) => issue.code);
  }

  toJSON() {
    return {
      assignedRequirementId: this.assignedRequirementId,
      secondaryRequirementIds: [...this.secondaryRequirementIds],
      assignedCovered: this.assignedCovered,
      validationResult: this.validationResult,
      recoverableIssues: [...this.recoverableIssues],
      recoverableIssueCodes: this.recoverableIssueCodes,
      ok: this.ok,
    };
  }
}

export class AssignedRequirementRecoverableIssue {
  constructor({ code, requirementId, file = null }) {
    if (!["assigned_requirement_missing_header", "assigned_requirement_missing_test_name", "assigned_requirement_uncovered"].includes(code)) {
      throw new Error(`invalid assigned requirement issue code: ${code}`);
    }
    const canonicalRequirementId = requiredRequirementId(requirementId, "requirementId");
    if (file !== null && (typeof file !== "string" || file.length === 0)) {
      throw new Error("file must be a non-empty string or null");
    }
    this.code = code;
    this.requirementId = canonicalRequirementId;
    this.file = file;
    Object.freeze(this);
  }

  toJSON() {
    return { code: this.code, requirementId: this.requirementId, file: this.file };
  }
}

function canonicalCandidatePath(candidatePath) {
  if (typeof candidatePath !== "string"
    || candidatePath.length === 0
    || candidatePath.includes("\\")
    || candidatePath.startsWith("/")
    || candidatePath.split("/").some((part) => part === "" || part === "." || part === "..")
    || !/^tests\/(?:.+\/)?[^/]+\.(?:test|spec)\.(?:js|ts|mjs)$/.test(candidatePath)) {
    throw new Error(`candidate path must be a canonical repository-relative spec test path: ${candidatePath}`);
  }
  return candidatePath;
}

/**
 * Validate a test bundle scoped to its assigned primary Requirement.
 * Structural checks are shared with global validation; only coverage is
 * narrowed to the assigned Requirement.
 */
export function validateAssignedRequirementTestHeaders({
  specDir,
  spec,
  assignedRequirementId,
  secondaryRequirementIds = [],
  candidatePaths,
}) {
  const assignedId = requiredRequirementId(assignedRequirementId, "assignedRequirementId");
  const secondaryIds = [...new Set(secondaryRequirementIds)];
  const requirements = Array.isArray(spec?.requirements) ? spec.requirements : [];
  const assigned = requirements.find((req) => req.id === assignedId);
  if (!assigned) throw new Error(`assigned requirement ${assignedId} is not defined`);
  if (assigned.testable === false) throw new Error(`assigned requirement ${assignedId} is not testable`);
  const knownIds = new Set(requirements.map((req) => req.id));
  for (const id of secondaryIds) {
    requiredRequirementId(id, "secondaryRequirementId");
    if (!knownIds.has(id)) throw new Error(`secondary requirement ${id} is not defined`);
  }

  if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) {
    throw new Error("candidatePaths must be a non-empty array");
  }
  const candidates = candidatePaths.map(canonicalCandidatePath);
  if (new Set(candidates).size !== candidates.length) throw new Error("candidatePaths must not contain duplicates");
  const fileHeaders = new Map();
  for (const candidate of candidates) {
    const file = path.join(specDir, candidate);
    const testsRoot = path.join(specDir, "tests");
    const resolved = path.resolve(file);
    if (!resolved.startsWith(`${path.resolve(testsRoot)}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`candidate path does not identify an existing spec test file: ${candidate}`);
    }
    const scan = scanFileHeader(resolved);
    fileHeaders.set(resolved, {
      headerIds: scan.kind === "valid" ? scan.ids : [],
      testNameIds: extractTestNameReqIds(resolved),
      scan,
    });
  }

  const validationResult = validateHeaderFiles({
    specDir,
    spec,
    coverageRequirementIds: new Set([assignedId]),
    selectedFileHeaders: fileHeaders,
  });
  const recoverableIssues = [];
  let assignedCovered = false;
  for (const [file, info] of fileHeaders) {
    const rel = path.relative(specDir, file);
    if (info.headerIds.includes(assignedId) && info.testNameIds.includes(assignedId)) assignedCovered = true;
    if (info.headerIds.includes(assignedId) && !info.testNameIds.includes(assignedId)) {
      recoverableIssues.push(new AssignedRequirementRecoverableIssue({ code: "assigned_requirement_missing_test_name", requirementId: assignedId, file: rel }));
    }
    if (!info.headerIds.includes(assignedId) && info.testNameIds.includes(assignedId)) {
      recoverableIssues.push(new AssignedRequirementRecoverableIssue({ code: "assigned_requirement_missing_header", requirementId: assignedId, file: rel }));
    }
  }
  if (!assignedCovered) {
    recoverableIssues.push(new AssignedRequirementRecoverableIssue({ code: "assigned_requirement_uncovered", requirementId: assignedId }));
  }
  return new AssignedRequirementTestValidation({
    assignedRequirementId: assignedId,
    secondaryRequirementIds: secondaryIds,
    validationResult,
    recoverableIssues,
    assignedCovered,
  });
}

/**
 * Build a human-readable summary of validation failures (errors[].messages).
 */
export function formatValidationMessages(result) {
  const msgs = [];
  if (result.missingHeaders.length > 0) {
    msgs.push(`${result.missingHeaders.length} file(s) missing spec header: ${result.missingHeaders.join(", ")}`);
  }
  if (result.uncoveredRequirements.length > 0) {
    const ids = result.uncoveredRequirements.map((r) => r.id).join(", ");
    msgs.push(`${result.uncoveredRequirements.length} testable requirement(s) uncovered: ${ids}`);
  }
  if (result.unknownIds.length > 0) {
    const items = result.unknownIds.map((u) => `${u.file}:${u.id}`).join(", ");
    msgs.push(`unknown requirement IDs in headers: ${items}`);
  }
  if (result.malformedHeaders.length > 0) {
    msgs.push(`${result.malformedHeaders.length} malformed header line(s) (use \`// spec: R1 R2 ...\`)`);
  }
  if (result.duplicateIds.length > 0) {
    msgs.push(`duplicate IDs in header: ${result.duplicateIds.map((d) => `${d.file}:${d.id}`).join(", ")}`);
  }
  if (result.duplicateHeaders.length > 0) {
    msgs.push(`multiple spec headers in single file: ${result.duplicateHeaders.map((d) => `${d.file}:${d.lineNumber}`).join(", ")}`);
  }
  if (result.notTestableInHeader.length > 0) {
    msgs.push(`testable: false requirements declared in header: ${result.notTestableInHeader.map((n) => `${n.file}:${n.id}`).join(", ")}`);
  }
  if (result.mismatchedMarker.length > 0) {
    msgs.push(`use // (not #) for spec header in JS-like files: ${result.mismatchedMarker.map((m) => m.file).join(", ")}`);
  }
  if (result.headerNoTest.length > 0) {
    msgs.push(`header declares a Requirement ID but no \`R1:\`-style test name in same file: ${result.headerNoTest.map((h) => `${h.file}:${h.id}`).join(", ")}`);
  }
  if (result.testNoHeader.length > 0) {
    msgs.push(`\`R1:\`-style test name without header declaration: ${result.testNoHeader.map((h) => `${h.file}:${h.id}`).join(", ")}`);
  }
  return msgs;
}
