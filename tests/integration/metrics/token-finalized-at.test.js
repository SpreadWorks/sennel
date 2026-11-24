import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { utimesSync } from "node:fs";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  createCanonicalTokenMetricsFlow,
  readTokenCache,
  runTokenCapture,
  runTokenJson,
  writeBaseConfig,
  writeTokenCache,
} from "../../support/builders/metrics-token.js";

function metric() {
  return [{
    phase: "draft",
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheCreation: 10,
    cost: 0.01,
    callCount: 2,
  }];
}

function finalizedActivity(flow) {
  return flow.flowManager.activityLedger(flow.specId)
    .find((activity) => activity.transition.operation === "finalize_flow");
}

describe("metrics token — flow_finalized Activity as date axis", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("uses flow_finalized Activity timing as the date column, not file mtime", async () => {
    tmp = createTmpDir("sennel-metrics-finalized-at-");
    writeBaseConfig(tmp);
    const flow = await createCanonicalTokenMetricsFlow(tmp, { agentMetrics: metric() });
    const finalization = finalizedActivity(flow);
    assert.ok(finalization?.timing?.finishedAt, "finalization must retain a timed Activity fact");
    utimesSync(flow.location.flowStateFile, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

    const parsed = JSON.parse(runTokenJson(tmp));
    const row = parsed.rows.find((entry) => entry.phase === "draft");
    assert.ok(row, "draft row should exist");
    assert.equal(row.date, finalization.timing.finishedAt.slice(0, 10));
  });

  it("skips non-finalized V1 Flows and prints a durable-fact warning", async () => {
    tmp = createTmpDir("sennel-metrics-finalized-at-missing-");
    writeBaseConfig(tmp);
    await createCanonicalTokenMetricsFlow(tmp, { specId: "001-alpha", finalized: false, agentMetrics: metric() });
    const completed = await createCanonicalTokenMetricsFlow(tmp, { specId: "002-beta", agentMetrics: metric() });

    const res = runTokenCapture(tmp);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr=${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    const draftRows = parsed.rows.filter((row) => row.phase === "draft");
    assert.equal(draftRows.length, 1, "only finalized Flows should be aggregated");
    assert.equal(draftRows[0].date, finalizedActivity(completed).timing.finishedAt.slice(0, 10));
    assert.match(res.stderr, /flow_finalized Activity timing/i);
  });

  it("invalidates a cache without the V1 input fingerprint and rebuilds", async () => {
    tmp = createTmpDir("sennel-metrics-finalized-at-cache-");
    writeBaseConfig(tmp);
    const flow = await createCanonicalTokenMetricsFlow(tmp, { agentMetrics: metric() });
    writeTokenCache(tmp, {
      generatedAt: "2020-01-01T00:00:00Z",
      rows: [{
        date: "2020-01-01",
        phase: "draft",
        difficulty: null,
        tokenInput: 999999,
        tokenOutput: 0,
        cacheRead: 0,
        cacheCreate: 0,
        callCount: 0,
        cost: 0,
      }],
    });

    runTokenJson(tmp);

    const cache = readTokenCache(tmp);
    assert.equal(cache.maxFinalizedAt, finalizedActivity(flow).timing.finishedAt);
    assert.match(cache.inputFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(cache.rows[0].tokenInput, 100, "legacy cache rows should be replaced with V1 aggregation");
    assert.equal(cache.rows[0].date, finalizedActivity(flow).timing.finishedAt.slice(0, 10));
  });

  it("reuses the cache when the canonical input fingerprint matches", async () => {
    tmp = createTmpDir("sennel-metrics-finalized-at-cache-reuse-");
    writeBaseConfig(tmp);
    await createCanonicalTokenMetricsFlow(tmp, { agentMetrics: metric() });
    runTokenJson(tmp);
    const cache = readTokenCache(tmp);
    cache.rows[0].tokenInput = 42;
    writeTokenCache(tmp, cache);

    const parsed = JSON.parse(runTokenJson(tmp));
    const row = parsed.rows.find((entry) => entry.phase === "draft");
    assert.equal(row.tokenInput, 42, "cached row should be returned as-is");
  });
});
