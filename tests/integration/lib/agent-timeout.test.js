import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentTimeout,
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_AGENT_PROCESS_TREE_GRACE_MS,
  OUTER_AGENT_PROCESS_TREE_TIMEOUT_ALLOWANCE_MS,
  MonotonicMilliseconds,
  TestReviewRepairWorkerMonitor,
  TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS,
} from "../../../src/lib/agent-timeout.js";

describe("AgentTimeout", () => {
  it("keeps the canonical default in seconds and converts only at the API boundary", () => {
    const timeout = AgentTimeout.fromConfig();

    assert.equal(DEFAULT_AGENT_TIMEOUT_SECONDS, 1_800);
    assert.equal(timeout.seconds, 1_800);
    assert.equal(timeout.toMilliseconds(), 1_800_000);
  });

  it("uses configured seconds", () => {
    const timeout = AgentTimeout.fromConfig({ timeout: 42 });

    assert.equal(timeout.seconds, 42);
    assert.equal(timeout.toMilliseconds(), 42_000);
  });

  it("gives an outer process time to finish its provider tree cleanup", () => {
    const timeout = AgentTimeout.fromConfig({ timeout: 42 });

    assert.equal(DEFAULT_AGENT_PROCESS_TREE_GRACE_MS, 100);
    assert.equal(OUTER_AGENT_PROCESS_TREE_TIMEOUT_ALLOWANCE_MS, 1_000);
    assert.equal(timeout.toOuterProcessMilliseconds(), 43_000);
  });

  it("rejects non-positive durations", () => {
    assert.throws(() => new AgentTimeout(0), /positive number of seconds/);
  });

  it("uses output and its own handoff subtree as activity, not process liveness", () => {
    let now = 0;
    let tree = new Map([["request.json", "initial"]]);
    const scheduled = [];
    const monitor = new TestReviewRepairWorkerMonitor({
      handoffDirectory: "/tmp/handoff",
      inactivityTimeoutMs: 900_000,
      clock: new MonotonicMilliseconds(() => now),
      schedule(callback) { scheduled.push(callback); return callback; },
      cancel() {},
      snapshot() { return { differsFrom(previous) { return previous?.tree !== tree; }, tree }; },
    });
    const reasons = [];
    monitor.start((diagnostic) => reasons.push(diagnostic.reason));

    now = 899_999;
    assert.equal(monitor.poll(), null);
    now = 900_000;
    monitor.observeOutput();
    assert.equal(monitor.poll(), null, "stdout extends the worker inactivity window");
    now = 1_799_999;
    monitor.observeSubmission();
    assert.equal(monitor.poll(), null, "submission extends the worker inactivity window");
    now = 2_699_998;
    tree = new Map([["request.json", "initial"], ["payload/test.js", "changed"]]);
    assert.equal(monitor.poll(), null, "handoff file creation extends the worker inactivity window");
    now = 3_599_997;
    tree = new Map([["request.json", "initial"], ["payload/test.js", "changed-again"]]);
    assert.equal(monitor.poll(), null, "handoff content changes extend the worker inactivity window");
    now = 3_599_998;
    tree = new Map([["request.json", "initial"]]);
    assert.equal(monitor.poll(), null, "handoff deletion extends the worker inactivity window");
    now = 4_499_997;
    monitor.observeOutput();
    assert.equal(monitor.poll(), null, "mere elapsed process lifetime below the hard limit is not inactivity");
    now = 5_399_997;
    assert.equal(monitor.poll(), "inactivity");
    assert.deepEqual(reasons, ["inactivity"]);
  });

  it("observes real create, content-change, and delete activity only below its handoff root", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-monitor-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "repair-monitor-outside-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    let now = 0;
    const monitor = new TestReviewRepairWorkerMonitor({
      handoffDirectory: root,
      inactivityTimeoutMs: 1_000,
      clock: new MonotonicMilliseconds(() => now),
      schedule() { return null; },
      cancel() {},
    });
    const reasons = [];
    monitor.start((diagnostic) => reasons.push(diagnostic.reason));

    now = 900;
    fs.writeFileSync(path.join(outside, "canonical.test.js"), "outside\n");
    assert.equal(monitor.poll(), null);
    now = 1_000;
    assert.equal(monitor.poll(), "inactivity", "outside changes cannot extend this worker");
    assert.deepEqual(reasons, ["inactivity"]);

    let activityNow = 0;
    const active = new TestReviewRepairWorkerMonitor({
      handoffDirectory: root,
      inactivityTimeoutMs: 1_000,
      clock: new MonotonicMilliseconds(() => activityNow),
      schedule() { return null; },
      cancel() {},
    });
    const activeReasons = [];
    active.start((diagnostic) => activeReasons.push(diagnostic.reason));
    const payload = path.join(root, "payload.test.js");
    activityNow = 900;
    fs.writeFileSync(payload, "created\n");
    assert.equal(active.poll(), null);
    activityNow = 1_800;
    fs.writeFileSync(payload, "content changed\n");
    assert.equal(active.poll(), null);
    activityNow = 2_700;
    fs.rmSync(payload);
    assert.equal(active.poll(), null);
    activityNow = 3_700;
    assert.equal(active.poll(), "inactivity");
    assert.deepEqual(activeReasons, ["inactivity"]);
  });

  it("hard-stops an active repair worker at 7200 seconds", () => {
    let now = 0;
    const monitor = new TestReviewRepairWorkerMonitor({
      handoffDirectory: "/tmp/handoff",
      inactivityTimeoutMs: 900_000,
      clock: new MonotonicMilliseconds(() => now),
      schedule() { return null; },
      cancel() {},
      snapshot() { return { differsFrom() { return false; } }; },
    });
    const reasons = [];
    monitor.start((diagnostic) => reasons.push(diagnostic.reason));
    for (now = 899_999; now < TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS * 1000; now += 899_999) {
      monitor.observeOutput();
      assert.equal(monitor.poll(), null);
    }
    now = TEST_REVIEW_REPAIR_WORKER_MAX_LIFETIME_SECONDS * 1000;
    assert.equal(monitor.poll(), "maximum_lifetime");
    assert.deepEqual(reasons, ["maximum_lifetime"]);
  });

  it("gives a simultaneous inactivity and lifetime expiry one maximum-lifetime owner", () => {
    let now = 0;
    const monitor = new TestReviewRepairWorkerMonitor({
      handoffDirectory: "/tmp/handoff",
      inactivityTimeoutMs: 1_000,
      maximumLifetimeMs: 1_000,
      clock: new MonotonicMilliseconds(() => now),
      schedule() { return null; },
      cancel() {},
      snapshot() { return { differsFrom() { return false; } }; },
    });
    const reasons = [];
    monitor.start((diagnostic) => reasons.push(diagnostic.reason));
    now = 1_000;
    assert.equal(monitor.poll(), "maximum_lifetime");
    assert.equal(monitor.poll(), null, "stopped monitor cannot acquire timeout ownership again");
    assert.deepEqual(reasons, ["maximum_lifetime"]);
  });

  it("keeps polling below the shortest valid configured Agent timeout", () => {
    const monitor = new TestReviewRepairWorkerMonitor({
      handoffDirectory: "/tmp/handoff",
      inactivityTimeoutMs: 1_000,
      schedule() { return null; },
      cancel() {},
      snapshot() { return { differsFrom() { return false; } }; },
    });

    assert.equal(monitor.pollIntervalMs, 100);
  });
});
