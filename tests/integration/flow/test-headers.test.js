/**
 * tests/integration/flow/test-headers.test.js
 *
 * Unit tests for src/flow/lib/test-headers.js (spec 249).
 * Covers parser, coverage evaluator, and validation categories.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const moduleUrl = new URL("../../../src/flow/lib/test-headers.js", import.meta.url);

async function loadModule() {
  return import(moduleUrl.href);
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-headers-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function specWithReqs(reqs) {
  return { requirements: reqs };
}

// R1: parser accepts valid `// spec: R1 R2`
test("R1: parseHeader accepts `// spec: R1 R2`", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec: R1 R2", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "valid");
  assert.deepEqual(result.ids, ["R1", "R2"]);
});

// R1: parser accepts valid `# spec: R1 R2` for non-JS extension
test("R1: parseHeader accepts `# spec: R1 R2` for .md", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("# spec: R1 R2", { ext: ".md", lineNumber: 1 });
  assert.equal(result.kind, "valid");
  assert.deepEqual(result.ids, ["R1", "R2"]);
});

// R4: MISMATCHED_MARKER for `# spec:` in .js
test("R4: parseHeader rejects `# spec:` in .js as mismatched marker", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("# spec: R1", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "mismatched-marker");
});

// R4: MALFORMED for missing colon
test("R4: parseHeader marks `// spec R1` as malformed (missing colon)", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec R1", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

// R4: MALFORMED for triple slash
test("R4: parseHeader marks `/// spec: R1` as malformed", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("/// spec: R1", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

// R4: MALFORMED for double hash
test("R4: parseHeader marks `## spec: R1` as malformed", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("## spec: R1", { ext: ".md", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

// R4: MALFORMED for empty header
test("R4: parseHeader rejects empty `// spec:`", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec:", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

// R4: MALFORMED for invalid R-ID format
test("R4: parseHeader rejects `// spec: r1` (lowercase)", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec: r1", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

test("R4: parseHeader rejects `// spec: R1a`", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec: R1a", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

test("R4: parseHeader rejects non-canonical `R0` IDs", async () => {
  const { parseHeader } = await loadModule();
  const result = parseHeader("// spec: R0", { ext: ".js", lineNumber: 1 });
  assert.equal(result.kind, "malformed");
});

// R4: duplicate IDs in single header
test("R4: scanFileHeader detects duplicate IDs", async () => {
  withTmpDir(async (root) => {
    const { scanFileHeader } = await loadModule();
    const file = writeFile(root, "foo.test.js", "// spec: R1 R1\nimport x;\n");
    const result = scanFileHeader(file);
    assert.equal(result.duplicateIds?.length, 1);
  });
});

// R1: shebang skip + license comment + valid header
test("R1: scanFileHeader skips shebang and license, then finds valid header", async () => {
  withTmpDir(async (root) => {
    const { scanFileHeader } = await loadModule();
    const content = "#!/usr/bin/env node\n// Copyright 2026\n// spec: R1\nimport x;\n";
    const file = writeFile(root, "foo.test.js", content);
    const result = scanFileHeader(file);
    assert.equal(result.kind, "valid");
    assert.deepEqual(result.ids, ["R1"]);
  });
});

// R1: missing header
test("R1: scanFileHeader returns missing when no spec header before code", async () => {
  withTmpDir(async (root) => {
    const { scanFileHeader } = await loadModule();
    const file = writeFile(root, "foo.test.js", "import x from 'y';\n");
    const result = scanFileHeader(file);
    assert.equal(result.kind, "missing");
  });
});

// R4: duplicate valid headers in same file
test("R4: scanFileHeader detects duplicate valid headers", async () => {
  withTmpDir(async (root) => {
    const { scanFileHeader } = await loadModule();
    // Both headers must come before code
    const content = "// spec: R1\n// spec: R2\n";
    const file = writeFile(root, "foo.test.js", content);
    const result = scanFileHeader(file);
    assert.equal(result.duplicateHeaders?.length >= 1, true);
  });
});

// R1+R8: discovery of spec test files
test("R1: getSpecTestFiles discovers .{test,spec}.{js,ts,mjs}", async () => {
  withTmpDir(async (root) => {
    const { getSpecTestFiles } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1\n");
    writeFile(specDir, "tests/b.spec.js", "// spec: R1\n");
    writeFile(specDir, "tests/c.test.ts", "// spec: R1\n");
    writeFile(specDir, "tests/d.test.mjs", "// spec: R1\n");
    writeFile(specDir, "tests/ignored.txt", "// spec: R1\n");
    const files = getSpecTestFiles(specDir);
    assert.equal(files.length, 4);
  });
});

// R12: discovery returns empty when tests dir absent
test("R12: getSpecTestFiles returns empty array when tests/ absent", async () => {
  withTmpDir(async (root) => {
    const { getSpecTestFiles } = await loadModule();
    const specDir = path.join(root, "specs", "foo");
    fs.mkdirSync(specDir, { recursive: true });
    const files = getSpecTestFiles(specDir);
    assert.deepEqual(files, []);
  });
});

// R3: coverage evaluator: all testable covered
test("R3: validateTestHeaders passes when all testable requirements covered", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1 R2\nimport { test, it } from 'node:test';\nit('R1: x', ()=>{});\nit('R2: y', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }, { id: "R2", desc: "..." }]),
    });
    assert.equal(result.ok, true);
  });
});

// R4: uncovered testable requirement
test("R4: validateTestHeaders reports uncoveredRequirements", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1\nit('R1: x', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }, { id: "R2", desc: "..." }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.uncoveredRequirements.find((r) => r.id === "R2") !== undefined, true);
  });
});

// R3: testable: false excluded from coverage
test("R3: testable: false requirements excluded from coverage", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1\nit('R1: x', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([
        { id: "R1", desc: "..." },
        { id: "R2", desc: "...", testable: false },
      ]),
    });
    assert.equal(result.ok, true);
  });
});

// R4: unknown ID
test("R4: validateTestHeaders reports unknownIds", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R99\nit('R99: x', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.unknownIds.length >= 1, true);
  });
});

// R4: notTestableInHeader
test("R4: validateTestHeaders reports notTestableInHeader", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1\nit('R1: x', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "...", testable: false }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.notTestableInHeader.length >= 1, true);
  });
});

// R4: headerNoTest (header declares R1 but no R1: test name in same file)
test("R4: validateTestHeaders reports headerNoTest", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R1\nit('something else', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.headerNoTest?.length >= 1, true);
  });
});

// R4: testNoHeader (R1: test exists but header doesn't declare it)
test("R4: validateTestHeaders reports testNoHeader", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R2\nit('R2: x', ()=>{});\nit('R1: leak', ()=>{});\n");
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }, { id: "R2", desc: "..." }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.testNoHeader?.length >= 1, true);
  });
});

// R12: no tests dir + only testable: false requirements => ok
test("R12: validateTestHeaders ok when all requirements are testable: false and no tests dir", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    fs.mkdirSync(specDir, { recursive: true });
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([
        { id: "R1", desc: "...", testable: false },
        { id: "R2", desc: "...", testable: false },
      ]),
    });
    assert.equal(result.ok, true);
  });
});

// R12: no tests dir + testable requirements => uncovered all
test("R12: validateTestHeaders fails uncovered when tests dir absent and testable requirements exist", async () => {
  withTmpDir(async (root) => {
    const { validateTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    fs.mkdirSync(specDir, { recursive: true });
    const result = validateTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R1", desc: "..." }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.uncoveredRequirements.length, 1);
  });
});

test("assigned validation counts only the assigned Requirement and allows a secondary Requirement", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders, AssignedRequirementTestValidation } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R6 R8\nit('R6: primary', ()=>{});\nit('R8: secondary', ()=>{});\n");
    const result = validateAssignedRequirementTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R6", desc: "..." }, { id: "R8", desc: "..." }]),
      assignedRequirementId: "R6",
      secondaryRequirementIds: ["R8"],
      candidatePaths: ["tests/a.test.js"],
    });
    assert.equal(result instanceof AssignedRequirementTestValidation, true);
    assert.equal(result.ok, true);
    assert.equal(result.assignedCovered, true);
    assert.deepEqual(result.secondaryRequirementIds, ["R8"]);
    assert.deepEqual(result.validationResult.uncoveredRequirements, []);
    assert.deepEqual(result.recoverableIssueCodes, []);
  });
});

test("assigned validation ignores pre-existing active tests outside the candidate bundle", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/active.test.js", "// spec: R6\nit('R6: active', ()=>{});\n");
    writeFile(specDir, "tests/candidate.test.js", "// spec: R8\nit('R8: secondary', ()=>{});\n");
    const result = validateAssignedRequirementTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R6", desc: "..." }, { id: "R8", desc: "..." }]),
      assignedRequirementId: "R6",
      secondaryRequirementIds: ["R8"],
      candidatePaths: ["tests/candidate.test.js"],
    });
    assert.equal(result.assignedCovered, false);
    assert.equal(result.recoverableIssueCodes.includes("assigned_requirement_uncovered"), true);
  });
});

test("assigned validation rejects escaped and non-test candidate paths", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/candidate.test.js", "// spec: R6\nit('R6: primary', ()=>{});\n");
    const args = {
      specDir,
      spec: specWithReqs([{ id: "R6", desc: "..." }]),
      assignedRequirementId: "R6",
    };
    assert.throws(() => validateAssignedRequirementTestHeaders({ ...args, candidatePaths: ["tests/../tests/candidate.test.js"] }), /canonical repository-relative/);
    assert.throws(() => validateAssignedRequirementTestHeaders({ ...args, candidatePaths: ["spec.json"] }), /canonical repository-relative/);
  });
});

test("assigned validation rejects non-canonical Requirement IDs", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/candidate.test.js", "// spec: R1\nit('R1: primary', ()=>{});\n");
    assert.throws(
      () => validateAssignedRequirementTestHeaders({
        specDir,
        spec: specWithReqs([{ id: "R1", desc: "..." }]),
        assignedRequirementId: "R-1",
        candidatePaths: ["tests/candidate.test.js"],
      }),
      /canonical requirement id/,
    );
  });
});

test("assigned validation rejects a bundle containing only a secondary Requirement", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R8\nit('R8: secondary', ()=>{});\n");
    const result = validateAssignedRequirementTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R6", desc: "..." }, { id: "R8", desc: "..." }]),
      assignedRequirementId: "R6",
      secondaryRequirementIds: ["R8"],
      candidatePaths: ["tests/a.test.js"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.assignedCovered, false);
    assert.equal(result.recoverableIssues.some((issue) => issue.code === "assigned_requirement_uncovered"), true);
    assert.deepEqual(result.validationResult.uncoveredRequirements.map((entry) => entry.id), ["R6"]);
  });
});

test("assigned validation reports missing primary header or test name as recoverable issues", async () => {
  withTmpDir(async (root) => {
    const { validateAssignedRequirementTestHeaders } = await loadModule();
    const specDir = path.join(root, "specs", "249-foo");
    writeFile(specDir, "tests/a.test.js", "// spec: R6\nit('R8: secondary', ()=>{});\n");
    const result = validateAssignedRequirementTestHeaders({
      specDir,
      spec: specWithReqs([{ id: "R6", desc: "..." }, { id: "R8", desc: "..." }]),
      assignedRequirementId: "R6",
      secondaryRequirementIds: ["R8"],
      candidatePaths: ["tests/a.test.js"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.recoverableIssues.some((issue) => issue.code === "assigned_requirement_missing_test_name"), true);
    assert.equal(result.validationResult.headerNoTest.some((entry) => entry.id === "R6"), true);
  });
});

test("assigned recoverable issues are immutable value objects", async () => {
  const { AssignedRequirementRecoverableIssue } = await loadModule();
  const issue = new AssignedRequirementRecoverableIssue({
    code: "assigned_requirement_uncovered",
    requirementId: "R6",
  });
  assert.equal(Object.isFrozen(issue), true);
  assert.deepEqual(issue.toJSON(), {
    code: "assigned_requirement_uncovered",
    requirementId: "R6",
    file: null,
  });
  assert.throws(() => new AssignedRequirementRecoverableIssue({ code: "uncovered_requirement", requirementId: "R6" }), /invalid assigned requirement issue code/);
});
