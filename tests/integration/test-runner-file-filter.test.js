/**
 * tests/integration/test-runner-file-filter.test.js
 *
 * Spec 229 — R1/R2/R3/R4/R5: --file, --pattern, positional args for
 * direct test file selection in tests/run.js.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_JS = resolve(ROOT, "tests", "run.js");

function run(...args) {
  return spawnSync("node", [RUN_JS, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 30_000,
  });
}

const TMP_DIR = resolve(ROOT, ".tmp", `test-file-filter-${process.pid}`);

function createTmpTest(relPath, content) {
  const full = join(TMP_DIR, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    content ||
      `import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("tmp", () => { it("passes", () => { assert.ok(true); }); });
`,
  );
  return full;
}

describe("tests/run.js --file (spec 229 R1)", () => {
  let tmpFile;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    tmpFile = createTmpTest("a.test.js");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("runs a single specified file", () => {
    const res = run("--file", tmpFile);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /child process execution record.*a\.test\.js/, "selected temporary test must actually execute");
  });

  it("runs multiple files when --file is repeated", () => {
    const tmpFile2 = createTmpTest("b.test.js");
    const res = run("--file", tmpFile, "--file", tmpFile2);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });

  it("exits non-zero for nonexistent file", () => {
    const res = run("--file", "/nonexistent/path.test.js");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });
});

describe("tests/run.js --pattern (spec 229 R2)", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    createTmpTest("pat-a.test.js");
    createTmpTest("pat-b.test.js");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("runs files matching a glob pattern", () => {
    const pattern = join(TMP_DIR, "pat-*.test.js");
    const res = run("--pattern", pattern);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });

  it("exits non-zero when pattern matches zero files", () => {
    const res = run("--pattern", join(TMP_DIR, "no-match-*.test.js"));
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });
});

describe("tests/run.js positional args (spec 229 R3)", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    createTmpTest("sub/deep.test.js");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("runs a positional file argument", () => {
    const f = createTmpTest("pos.test.js");
    const res = run(f);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });

  it("recursively collects .test.js from a positional directory", () => {
    const res = run(TMP_DIR);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });
});

describe("tests/run.js mutual exclusion (spec 229 R4)", () => {
  let tmpFile;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    tmpFile = createTmpTest("excl.test.js");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("rejects --file with --preset", () => {
    const res = run("--file", tmpFile, "--preset", "base");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });

  it("rejects --file with --scope", () => {
    const res = run("--file", tmpFile, "--scope", "unit");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });

  it("rejects --file with --agent", () => {
    const res = run("--file", tmpFile, "--agent");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });

  it("rejects --file with --all", () => {
    const res = run("--file", tmpFile, "--all");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });

  it("rejects --pattern with --preset", () => {
    const res = run("--pattern", join(TMP_DIR, "*.test.js"), "--preset", "base");
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.length > 0);
  });
});

describe("tests/run.js file-spec union (spec 229 R1/R2 combined)", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("--file + --pattern results are unioned", () => {
    const f = createTmpTest("union-a.test.js");
    createTmpTest("union-b.test.js");
    const pattern = join(TMP_DIR, "union-b.test.js");
    const res = run("--file", f, "--pattern", pattern);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });
});

describe("tests/run.js label summary with file-spec (spec 229 R5)", () => {
  let tmpFile;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    tmpFile = createTmpTest("label.test.js");
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("displays label summary when using --file", () => {
    const res = run("--file", tmpFile);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const combined = res.stdout + res.stderr;
    assert.ok(
      /unit|integration|acceptance/i.test(combined),
      "label summary expected in output",
    );
  });
});

describe("tests/run.js default selection unchanged (spec 229 AC9)", () => {
  it("no suite selector keeps the default selection", () => {
    const res = run("--list", "--json");
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const listing = JSON.parse(res.stdout);
    assert.equal(listing.selection.mode, "default");
    assert.ok(listing.suites.find(({ category }) => category === "structure").count > 0);
  });

  it("--scope structure lists only the structure suite", () => {
    const res = run("--scope", "structure", "--list", "--json");
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const listing = JSON.parse(res.stdout);
    assert.equal(listing.selection.scope, "structure");
    assert.ok(listing.suites.find(({ category }) => category === "structure").count > 0);
    assert.equal(listing.suites.filter(({ count }) => count > 0).length, 1);
  });

  it("--all lists structure and agent as distinct suites", () => {
    const res = run("--all", "--list", "--json", "--jobs", "1");
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const listing = JSON.parse(res.stdout);
    assert.ok(listing.suites.find(({ category }) => category === "structure").count > 0);
    assert.ok(listing.suites.find(({ category }) => category === "agent").count > 0);
  });
});

describe("structure suite file selectors", () => {
  it("--file and --pattern listings classify structure tests consistently", () => {
    const file = "tests/structure/draft.test.js";
    const fileResult = run("--file", file, "--list", "--json");
    assert.equal(fileResult.status, 0, `stderr: ${fileResult.stderr}`);
    assert.deepEqual(JSON.parse(fileResult.stdout).suites.find(({ category }) => category === "structure").files, [file]);

    const patternResult = run("--pattern", "tests/structure/*.test.js", "--list", "--json");
    assert.equal(patternResult.status, 0, `stderr: ${patternResult.stderr}`);
    assert.ok(JSON.parse(patternResult.stdout).suites.find(({ category }) => category === "structure").count > 0);
  });
});
