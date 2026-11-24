/**
 * tests/acceptance/report.test.js
 *
 * E2E tests for acceptance test report generation.
 * Verifies pipeline traceability and report JSON output.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { copyFixture, runPipeline } from "./lib/pipeline.js";
import { getAcceptanceFixtureDir } from "./lib/targets.js";

describe("acceptance report: pipeline traceability", { timeout: 300000 }, () => {
  let tmp;
  let workRoot;
  afterEach(() => {
    workRoot?.cleanup();
    workRoot = null;
    tmp = null;
  });

  it("runPipeline returns step timing for each pipeline step", async () => {
    const fixtureDir = getAcceptanceFixtureDir("base");
    workRoot = copyFixture(fixtureDir, { type: "base", agent: null });
    tmp = workRoot.root;

    const result = await runPipeline(tmp);

    assert.ok(result.steps, "runPipeline should return steps array");
    assert.ok(Array.isArray(result.steps), "steps should be an array");

    const expectedNames = ["scan", "enrich", "init", "data", "text", "readme"];
    const stepNames = result.steps.map((s) => s.name);

    for (const name of expectedNames) {
      assert.ok(stepNames.includes(name), `steps should include "${name}"`);
    }

    for (const step of result.steps) {
      assert.ok(typeof step.name === "string", "step.name should be a string");
      assert.ok(
        ["ok", "skipped", "error", "agent-error"].includes(step.status),
        `step.status should be one of ok/skipped/error/agent-error, got "${step.status}"`,
      );
      assert.ok(typeof step.durationMs === "number", "step.durationMs should be a number");
      assert.ok(step.durationMs >= 0, "step.durationMs should be non-negative");
    }
  });

  it("failed step records status as error", async () => {
    const fixtureDir = getAcceptanceFixtureDir("base");
    const badWorkRoot = copyFixture(fixtureDir, { type: "base", agent: null });
    const badTmp = badWorkRoot.root;

    try {
      const outputDir = path.join(badTmp, ".sennel", "output");
      fs.rmSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(badTmp, ".sennel", "output"), "not-a-dir");
      await assert.rejects(runPipeline(badTmp), (error) => error.stepResult?.status === "error");
    } finally {
      badWorkRoot.cleanup();
    }
  });

});

describe("acceptance report: JSON output", { timeout: 300000 }, () => {
  let tmp;
  let workRoot;
  afterEach(() => {
    workRoot?.cleanup();
    workRoot = null;
    tmp = null;
  });

  it("report JSON is written to .sennel/output/acceptance-report.json", async () => {
    const fixtureDir = getAcceptanceFixtureDir("base");
    workRoot = copyFixture(fixtureDir, { type: "base", agent: null });
    tmp = workRoot.root;

    await runPipeline(tmp);

    const { writeReport } = await import("./lib/test-template.js");
    const report = {
      preset: "base",
      timestamp: new Date().toISOString(),
      pipeline: { steps: [] },
      directives: { unfilled: [], exposed: [] },
      quality: null,
    };

    const reportPath = path.join(tmp, ".sennel", "output", "acceptance-report.json");
    writeReport(reportPath, report);

    assert.ok(fs.existsSync(reportPath), "report JSON should be written");

    const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(written.preset, "base");
    assert.ok(written.timestamp);
    assert.ok(written.pipeline);
    assert.ok(written.directives);
  });

});
