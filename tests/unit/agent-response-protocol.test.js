import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentResponseProtocolEvidence, AgentResponseProtocolFailure, EvaluationUnavailable,
  FileReadUnavailable, ContextLimitUnavailable, executeAgentResponseProtocol,
} from "../../src/lib/agent-response-protocol.js";

const unavailable = (kind, reason = "Explicit failure") => ({ kind, reason });

it("classifies only strict typed unavailable values as read retryable", () => {
  assert.ok(EvaluationUnavailable.from(unavailable("file-read-failed")) instanceof FileReadUnavailable);
  assert.ok(EvaluationUnavailable.from(unavailable("context-limit")) instanceof ContextLimitUnavailable);
  for (const value of [{ reason: "read failed" }, unavailable("unknown"), unavailable("file-read-failed", " "),
    { ...unavailable("file-read-failed"), extra: true }]) assert.throws(() => EvaluationUnavailable.from(value));
  assert.equal(EvaluationUnavailable.from(unavailable("evaluation-failed")).retryable, false);
});

it("shares one response loop between one format repair and three read retries", async () => {
  const requests = [];
  const responses = ["malformed", "file-read-failed", "file-read-failed", "accepted"];
  const result = await executeAgentResponseProtocol({ groupIdentity: "generic-group", maxFileReadRetries: 3,
    callAgent: async (request) => { requests.push(request); return responses.shift(); },
    parseResponse: (raw) => {
      if (raw === "malformed") throw new Error("format invalid");
      return raw === "file-read-failed" ? new FileReadUnavailable("open failed") : raw;
    },
  });
  assert.equal(result.value, "accepted");
  assert.deepEqual(requests.map((request) => request.retryKind), [null, "format", "file-read", "file-read"]);
  assert.deepEqual(requests.map((request) => request.cacheMode), ["default", "bypass", "bypass", "bypass"]);
  const group = result.evidence.groups[0];
  assert.equal(group.stopReason, "recovered");
  assert.deepEqual(group.attempts.map((entry) => entry.failureKind), ["format-failure", "file-read-failed", "file-read-failed", null]);
  assert.equal(group.providerAttemptCount, 4);
  assert.equal(group.responseCallCount, 4);
  assert.equal(result.evidence.hasFileInput, false);
  assert.equal(AgentResponseProtocolEvidence.from({ groups: [{ ...group.toJSON(),
    inputDigest: "a".repeat(64), inputByteLength: 20,
  }] }).hasFileInput, true);
  assert.deepEqual(AgentResponseProtocolEvidence.from(structuredClone(result.evidence)).toJSON(), result.evidence.toJSON());
  const invalid = result.evidence.toJSON();
  invalid.groups[0].attempts[1].attempt = 1;
  invalid.groups[0].attempts[1].responseAttemptOrdinal = 1;
  assert.throws(() => AgentResponseProtocolEvidence.from(invalid), /order and totals/);
});

it("stops context exhaustion and provider exceptions without guessing a read failure", async () => {
  for (const response of [new ContextLimitUnavailable("Too large"), new Error("file read failed in provider transport")]) {
    let calls = 0;
    await assert.rejects(executeAgentResponseProtocol({ groupIdentity: "stop-group", maxFileReadRetries: 3,
      callAgent: async () => { calls += 1; if (response instanceof Error) throw response; return "response"; },
      parseResponse: () => response,
    }), (error) => {
      assert.ok(error instanceof AgentResponseProtocolFailure);
      assert.equal(error.data.failureMode, response instanceof Error ? "provider_failure" : "context_limit");
      assert.equal(error.evidence.groups[0].attempts[0].responseCallCount, 1);
      return true;
    });
    assert.equal(calls, 1);
  }
});

it("preserves fresh format repair and cache rejection for a generic non-Gate caller", async () => {
  await assert.rejects(executeAgentResponseProtocol({ groupIdentity: "fresh-group",
    callAgent: async (request) => ({ text: "invalid", cacheOutcome: "hit", providerCalled: false, fresh: false }),
    parseResponse: () => { throw new Error("invalid output"); },
  }), (error) => {
    assert.equal(error.data.failureMode, "cached_replay");
    assert.equal(error.evidence.groups[0].providerAttemptCount, 0);
    return true;
  });
});
