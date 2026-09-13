import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentTimeout,
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_AGENT_PROCESS_TREE_GRACE_MS,
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

  it("rejects non-positive durations", () => {
    assert.throws(() => new AgentTimeout(0), /positive number of seconds/);
  });
});
