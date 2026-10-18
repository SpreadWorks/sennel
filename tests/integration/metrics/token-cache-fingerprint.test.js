import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";
import {
  createCanonicalTokenMetricsFlow,
  readTokenCache,
  runTokenJson,
  writeBaseConfig,
  writeTokenCache,
} from "../../support/builders/metrics-token.js";

async function createFlow(tmp, specId, tokenInput) {
  return createCanonicalTokenMetricsFlow(tmp, {
    specId,
    agentMetrics: [{ phase: "draft", input: tokenInput, output: 1, cacheRead: 0, cacheCreation: 0, cost: 0.01 }],
  });
}

function draftInput(output) {
  return JSON.parse(output).rows.find((row) => row.phase === "draft")?.tokenInput;
}

describe("metrics token content-addressed cache", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("ignores a changed retired root flow.json when canonical input is unchanged", async () => {
    tmp = createTmpDir("sennel-metrics-cache-canonical-only-");
    writeBaseConfig(tmp);
    await createFlow(tmp, "001-alpha", 100);
    assert.equal(draftInput(runTokenJson(tmp)), 100);

    // This is intentionally an invalid retired-layout document. A V1 reader
    // must not treat it as a cache input or second authority.
    writeJson(tmp, "specs/001-alpha/flow.json", {
      state: { finalizedAt: "2099-01-01T00:00:00.000Z" },
      metrics: { draft: { tokens: { input: 101 } } },
    });

    assert.equal(draftInput(runTokenJson(tmp)), 100);
  });

  it("rebuilds when a second canonical finalized Flow is added", async () => {
    tmp = createTmpDir("sennel-metrics-cache-add-");
    writeBaseConfig(tmp);
    await createFlow(tmp, "001-alpha", 100);
    assert.equal(draftInput(runTokenJson(tmp)), 100);

    await createFlow(tmp, "002-beta", 200);

    assert.equal(draftInput(runTokenJson(tmp)), 300);
  });

  it("rebuilds when a canonical Version root is removed", async () => {
    tmp = createTmpDir("sennel-metrics-cache-delete-");
    writeBaseConfig(tmp);
    await createFlow(tmp, "001-alpha", 100);
    const deleted = await createFlow(tmp, "002-beta", 200);
    assert.equal(draftInput(runTokenJson(tmp)), 300);

    rmSync(deleted.location.directory, { recursive: true, force: true });

    assert.equal(draftInput(runTokenJson(tmp)), 100);
  });

  it("reuses the cache when the canonical input set and contents are unchanged", async () => {
    tmp = createTmpDir("sennel-metrics-cache-hit-");
    writeBaseConfig(tmp);
    await createFlow(tmp, "001-alpha", 100);
    runTokenJson(tmp);
    const cache = readTokenCache(tmp);
    assert.match(cache.inputFingerprint, /^[a-f0-9]{64}$/);
    cache.rows[0].tokenInput = 42;
    writeTokenCache(tmp, cache);

    assert.equal(draftInput(runTokenJson(tmp)), 42);
  });
});
