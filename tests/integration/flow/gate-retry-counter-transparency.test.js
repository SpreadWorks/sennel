import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { countGateRetry } from "../../../src/flow/lib/run-gate.js";

const SENNEL_CMD = path.join(process.cwd(), "src/sennel.js");

function activeFixture(root) {
  const flowManager = makeFlowManager(root);
  return new CanonicalFlowFixture({
    flowManager,
    execution: { mode: "direct", baseBranch: "main" },
  }).create().registerActive();
}

describe("countGateRetry ignores non-gateRetry metric entries (REQ-4)", () => {
  it("does not count issueLog metrics as gateRetry", () => {
    const metrics = [
      { phase: "task-impl", counter: "issueLog", delta: 1 },
      { phase: "task-impl", counter: "issueLog", delta: 1 },
      { phase: "task-impl", counter: "gateRetry", delta: 1 },
    ];
    assert.equal(countGateRetry(metrics, "task-impl"), 1);
  });

  it("returns 0 when only issueLog entries exist", () => {
    const metrics = [
      { phase: "task-impl", counter: "issueLog", delta: 1 },
      { phase: "task-impl", counter: "issueLog", delta: 1 },
    ];
    assert.equal(countGateRetry(metrics, "task-impl"), 0);
  });

  it("does not count docsRead or srcRead as gateRetry", () => {
    const metrics = [
      { phase: "task-impl", counter: "docsRead", delta: 1 },
      { phase: "task-impl", counter: "srcRead", delta: 1 },
      { phase: "task-impl", counter: "question", delta: 1 },
    ];
    assert.equal(countGateRetry(metrics, "task-impl"), 0);
  });
});

describe("issue-log recording does not increment gateRetry (REQ-4)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("flow set issue-log leaves gateRetry count at zero", async () => {
    tmp = fixtureRepository("gate-counter-issue-log-");
    setupFlowConfig(tmp, "ja");
    await activeFixture(tmp).activateWithProducers("impl-gate");

    const result = spawnSync(
      "node",
      [SENNEL_CMD, "flow", "set", "issue-log", "--step", "impl-gate",
        "--reason", "fix: some issue that was fixed during implementation"],
      { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } },
    );
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const flow = makeFlowManager(tmp).loadReadOnly();
    const gateRetryEntries = (flow.metrics || [])
      .filter((entry) => entry.counter === "gateRetry");
    assert.equal(gateRetryEntries.length, 0,
      "flow set issue-log must not create any gateRetry metric entries");
  });
});
