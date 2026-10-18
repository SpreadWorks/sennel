import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SeedCleanupScope, SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { CanonicalScenarioSeed } from "../../support/assertions/canonical-persistence.js";
import { buildRowsFromMetrics, formatCsv } from "../../../src/metrics/commands/token.js";
import { makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  createCanonicalTokenMetricsFlow,
  runToken,
  writeBaseConfig,
} from "../../support/builders/metrics-token.js";

const seedScope = new SeedCleanupScope(after);

describe("metrics token command", () => {
  let tmp;
  let defaultProjectSeed;
  afterEach(() => tmp && removeTmpDir(tmp));

  async function setupProject() {
    defaultProjectSeed ??= (async () => {
      const producerRoot = createTmpDir("sennel-metrics-token-producer-");
      try {
        writeBaseConfig(producerRoot);
        const produced = await createCanonicalTokenMetricsFlow(producerRoot);
        return CanonicalScenarioSeed.freeze(seedScope, { root: producerRoot, specId: produced.specId,
          manager: produced.flowManager, prefix: "sennel-metrics-token-seed-" });
      } finally { removeTmpDir(producerRoot); }
    })();
    const seed = await defaultProjectSeed;
    tmp = new SeedWorkRoot(seed.root, { prefix: "sennel-metrics-token-case-" }).root;
    const manager = makeFlowManager(tmp);
    seed.assertClone(manager);
    return manager;
  }

  async function setupProjectWithDifficultyData() {
    tmp = createTmpDir("sennel-metrics-token-diff-");
    writeBaseConfig(tmp);
    return await createCanonicalTokenMetricsFlow(tmp, {
      request: "metrics difficulty test request",
      goal: "A".repeat(1600),
      requirements: [{ id: "R-1", desc: "Preserve canonical metric inputs." }],
      draftQuestions: 1,
      issueEntries: [{ step: "draft", reason: "recorded canonical issue fact" }],
      agentMetrics: [{
        phase: "draft",
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheCreation: 10,
        cost: 0.01,
        callCount: 2,
      }],
    });
  }

  it("supports json format and returns aggregated rows", async () => {
    const flowManager = await setupProject();
    const out = runToken(tmp, ["--format", "json"]);
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.rows), "json output should include rows array");
    assert.ok(parsed.rows.length >= 1, "rows should not be empty");
    assert.equal(flowManager.specLocation("001-alpha").relativeSpecFile, "specs/001-alpha/001/spec.json");
  });

  it("uses text format by default and prints phase sections", async () => {
    await setupProject();
    const out = runToken(tmp);
    assert.match(out, /-- draft -+/i);
    assert.match(out, /difficulty/i);
    assert.match(out, /call count/i);
  });

  it("supports csv format with expected headers", async () => {
    await setupProject();
    const out = runToken(tmp, ["--format", "csv"]);
    assert.match(
      out,
      /date,phase,specCount,difficulty,tokenInput,tokenOutput,cacheRead,cacheCreate,cacheHitRate,callCount,cost/i,
    );
  });

  it("computes numeric difficulty from cataloged Spec, Issue, and Activity inputs", async () => {
    await setupProjectWithDifficultyData();
    const parsed = JSON.parse(runToken(tmp, ["--format", "json"]));
    const row = parsed.rows.find((entry) => entry.phase === "draft");
    assert.ok(row, "draft row should exist");
    assert.equal(typeof row.difficulty, "number");
    assert.ok(row.difficulty > 0, "difficulty should be positive");
  });

  it("does not require retired reviewCount or redoCount state fields", async () => {
    await setupProject();
    const lines = runToken(tmp, ["--format", "csv"]).trim().split("\n");
    assert.ok(lines.length >= 2, "csv must include at least one data row");
    const cols = lines[1].split(",");
    assert.notEqual(cols[3], "—", "V1 derives review count from Activities");
  });

  it("treats absent optional Issue and question observations as zero", async () => {
    tmp = createTmpDir("sennel-metrics-token-zeroable-");
    writeBaseConfig(tmp);
    await createCanonicalTokenMetricsFlow(tmp, {
      goal: "B".repeat(1200),
      requirements: [{ id: "R-1", desc: "Metric input." }],
      agentMetrics: [{ phase: "draft", input: 10, output: 5, cacheRead: 2, cacheCreation: 1, cost: 0.001 }],
    });
    const parsed = JSON.parse(runToken(tmp, ["--format", "json"]));
    const row = parsed.rows.find((entry) => entry.phase === "draft");
    assert.ok(row);
    assert.equal(typeof row.difficulty, "number");
    assert.ok(row.difficulty > 0);
  });

  it("renders unavailable difficulty as — in CSV output", () => {
    const rows = buildRowsFromMetrics("2026-10-17", {
      draft: { tokens: { input: 10, output: 5, cacheRead: 2, cacheCreation: 1 },
        cost: 0.001, callCount: 1 },
    }, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].difficulty, null);
    const lines = formatCsv(rows).trim().split("\n");
    const columns = lines[0].split(",");
    assert.equal(lines[1].split(",")[columns.indexOf("difficulty")], "—");
  });
});
