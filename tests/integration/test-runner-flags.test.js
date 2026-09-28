/**
 * tests/integration/test-runner-flags.test.js
 *
 * Spec 212 — R1/R2/R3/R5: tests/run.js --agent / --all selector semantics.
 * Covers the pure helpers (buildSearchDirs / validateFlags) and the
 * end-to-end behavior of `node tests/run.js --agent --preset <x>` rejection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSearchDirs,
  validateFlags,
} from "../runner/test-runner-search-dirs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_JS = resolve(ROOT, "tests", "run.js");

describe("buildSearchDirs", () => {
  it("default (no flags) returns every deterministic suite and bundled preset acceptance", () => {
    const dirs = buildSearchDirs({ root: ROOT }, {});
    assert.ok(dirs.some((d) => d.endsWith("/tests/unit")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/integration")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/e2e")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/acceptance")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/structure")));
    assert.ok(dirs.some((d) => d.endsWith("/src/presets")));
    assert.ok(!dirs.some((d) => d.endsWith("/tests/agent")));
  });

  it("--agent returns only tests/agent", () => {
    const dirs = buildSearchDirs({ root: ROOT }, { agent: true });
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0].endsWith("/tests/agent"));
  });

  it("--all returns default dirs plus tests/agent", () => {
    const dirs = buildSearchDirs({ root: ROOT }, { all: true });
    assert.ok(dirs.some((d) => d.endsWith("/tests/unit")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/e2e")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/integration")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/acceptance")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/structure")));
    assert.ok(dirs.some((d) => d.endsWith("/src/presets")));
    assert.ok(dirs.some((d) => d.endsWith("/tests/agent")));
  });

  it("--preset preserves existing preset search behavior and excludes tests/agent", () => {
    const dirs = buildSearchDirs({ root: ROOT }, { preset: "sample-runtime" });
    assert.ok(!dirs.some((d) => d.endsWith("/tests/agent")));
  });

  it("--scope unit returns unit dirs only and excludes tests/agent", () => {
    const dirs = buildSearchDirs({ root: ROOT }, { scope: "unit" });
    assert.ok(dirs.some((d) => d.endsWith("/tests/unit")));
    assert.ok(!dirs.some((d) => d.endsWith("/tests/e2e")));
    assert.ok(!dirs.some((d) => d.endsWith("/tests/agent")));
  });

  it("--scope structure returns the structure suite only", () => {
    assert.deepEqual(buildSearchDirs({ root: ROOT }, { scope: "structure" }), [resolve(ROOT, "tests", "structure")]);
  });
});

describe("validateFlags", () => {
  const accepted = [
    ["no flags", {}],
    ["--agent alone", { agent: true }],
    ["--all alone", { all: true }],
    ["--file alone", { hasFile: true }],
    ["--pattern alone", { hasPattern: true }],
    ["positional alone", { hasPositional: true }],
    ["--file + --pattern", { hasFile: true, hasPattern: true }],
    ["--file + positional", { hasFile: true, hasPositional: true }],
    ["--pattern + positional", { hasPattern: true, hasPositional: true }],
    ["all file-spec flags", { hasFile: true, hasPattern: true, hasPositional: true }],
  ];

  for (const [name, input] of accepted) {
    it(`accepts ${name}`, () => {
      assert.equal(validateFlags(input).error, null);
    });
  }

  const rejected = [
    ["--agent + --preset", { agent: true, preset: "sample-runtime" }],
    ["--agent + --scope", { agent: true, scope: "unit" }],
    ["--agent + --all", { agent: true, all: true }],
    ["--file + --preset", { hasFile: true, preset: "sample-runtime" }],
    ["--file + --scope", { hasFile: true, scope: "unit" }],
    ["--file + --agent", { hasFile: true, agent: true }],
    ["--file + --all", { hasFile: true, all: true }],
    ["--pattern + --preset", { hasPattern: true, preset: "sample-runtime" }],
    ["--pattern + --agent", { hasPattern: true, agent: true }],
    ["positional + --scope", { hasPositional: true, scope: "unit" }],
    ["positional + --all", { hasPositional: true, all: true }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      assert.ok(validateFlags(input).error);
    });
  }

  it("--agent error message mentions --agent", () => {
    assert.match(validateFlags({ agent: true, preset: "sample-runtime" }).error, /--agent/);
  });
});

describe("tests/run.js integration — flag rejection", () => {
  it("--agent --preset exits non-zero with stderr", () => {
    const res = spawnSync("node", [RUN_JS, "--agent", "--preset", "sample-runtime"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--agent/);
  });

  it("--agent --scope unit exits non-zero with stderr", () => {
    const res = spawnSync("node", [RUN_JS, "--agent", "--scope", "unit"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--agent/);
  });
});
