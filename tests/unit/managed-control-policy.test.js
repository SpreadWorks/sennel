import test from "node:test";
import assert from "node:assert/strict";
import { ManagedControlPolicy } from "../../src/lib/managed-control-policy.js";
import { managedRequest, managedControlFailure } from "../../src/lib/managed-process-protocol.js";

const call = Object.freeze({ executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", callId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ownerToken: "private-owner", capability: "private-capability", endpoint: "unused" });
const unavailable = () => managedControlFailure("PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE", "Managed endpoint unavailable");

function clock() {
  let current = 0;
  return { now: () => current, advance: (ms) => { current += ms; }, wait: async (ms) => { current += ms; } };
}

test("managed communication policy owns the three cumulative response slots", () => {
  const policy = new ManagedControlPolicy();
  assert.equal(policy.attemptCount, 3);
  assert.equal(policy.budgetMs, 14000);
  assert.deepEqual([1, 2, 3].map((number) => policy.responseDeadlineMs(number)), [2000, 6000, 14000]);
  assert.throws(() => new ManagedControlPolicy({ attemptCount: 4 }), TypeError);
  assert.throws(() => new ManagedControlPolicy({ initialMs: 3000 }), TypeError);
});

test("early disconnects retain one physical request and consume the remaining response slots", async () => {
  const time = clock();
  const messages = [];
  const starts = [];
  const payload = { environment: { SECRET: "private-value" }, permit: "same-permit" };
  await assert.rejects(managedRequest(call, "start", payload, { ...time,
    request: async (_call, message) => {
      starts.push(time.now()); messages.push(JSON.stringify(message));
      payload.environment.SECRET = "changed-after-first-send";
      throw unavailable();
    },
  }), (error) => {
    assert.equal(error.retryable, false);
    assert.equal(error.communication.cutoff, "budget-exhausted");
    assert.equal(error.communication.elapsedMs, 14000);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.responseDeadlineMs), [2000, 6000, 14000]);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.elapsedMs), [0, 0, 0]);
    assert.equal(JSON.stringify(error.toJSON()).includes("private-"), false);
    return true;
  });
  assert.deepEqual(starts, [0, 2000, 6000]);
  assert.equal(new Set(messages).size, 1);
  assert.equal(time.now(), 14000);
});

test("full response timeouts do not add a second delay after each consumed slot", async () => {
  const time = clock();
  let waits = 0;
  await assert.rejects(managedRequest(call, "status", {}, { ...time,
    wait: async () => { waits++; },
    request: async (_call, _message, { timeoutMs }) => { time.advance(timeoutMs); throw unavailable(); },
  }), (error) => {
    assert.equal(error.communication.elapsedMs, 14000);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.elapsedMs), [2000, 4000, 8000]);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.outcome), ["timeout", "timeout", "timeout"]);
    return true;
  });
  assert.equal(waits, 0);
});

test("operation deadline cuts off remaining slot waiting without consuming later attempts", async () => {
  const time = clock();
  await assert.rejects(managedRequest(call, "status", {}, { ...time, deadline: 2500,
    request: async () => { throw unavailable(); },
  }), (error) => {
    assert.equal(error.communication.cutoff, "operation-deadline");
    assert.equal(error.communication.elapsedMs, 2500);
    assert.deepEqual(error.communication.attempts.map((attempt) => attempt.responseDeadlineMs), [2000, 2500]);
    return true;
  });
});

test("abort interrupts a failed connection's wait and does not issue another request", async () => {
  const time = clock();
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(managedRequest(call, "start", {}, { ...time, abortSignal: controller.signal,
    wait: async (ms) => { time.advance(ms); controller.abort(); },
    request: async () => { requests++; throw unavailable(); },
  }), (error) => {
    assert.equal(error.communication.cutoff, "aborted");
    assert.equal(error.communication.elapsedMs, 20);
    return true;
  });
  assert.equal(requests, 1);
});

test("durable completion during a failed slot converges before another transmission", async () => {
  const time = clock();
  const terminal = { state: "finished", outcome: { code: 0 } };
  let requests = 0;
  let drains = 0;
  const result = await managedRequest(call, "start", {}, { ...time,
    onWait: () => { drains++; }, readSettlement: () => time.now() >= 60 ? terminal : null,
    request: async () => { requests++; throw unavailable(); },
  });
  assert.equal(result, terminal);
  assert.equal(time.now(), 60);
  assert.equal(requests, 1);
  assert.equal(drains >= 4, true);
});

test("verified refusal fails immediately after checking durable settlement", async () => {
  const time = clock();
  let reads = 0;
  let requests = 0;
  await assert.rejects(managedRequest(call, "start", {}, { ...time,
    readSettlement: () => { reads++; return null; },
    request: async () => { requests++; throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Start was refused"); },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_REQUEST_MISMATCH");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.acceptance, "rejected");
    assert.equal(error.communication.elapsedMs, 0);
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(reads, 2);
});

test("authenticated acceptance is preserved when the response budget is exhausted", async () => {
  const time = clock();
  await assert.rejects(managedRequest(call, "start", {}, { ...time, readAcceptance: (request) => request.operation === "start" ? "accepted" : "unknown",
    request: async () => { throw unavailable(); },
  }), (error) => {
    assert.equal(error.communication.acceptance, "accepted");
    assert.equal(error.communication.stopConfirmation, "unknown");
    return true;
  });
});

test("the second response slot admits a response taking longer than the initial two seconds", async () => {
  const time = clock();
  let attempts = 0;
  const result = await managedRequest(call, "status", {}, { ...time,
    request: async (_call, _message, { timeoutMs }) => {
      attempts++;
      if (attempts === 1) { time.advance(timeoutMs); throw unavailable(); }
      assert.equal(timeoutMs, 4000);
      time.advance(3000);
      return { state: "running" };
    },
  });
  assert.deepEqual(result, { state: "running" });
  assert.equal(time.now(), 5000);
  assert.equal(attempts, 2);
});

test("authoritative durability failure during a retry wait fails before the next request", async () => {
  const time = clock();
  let requests = 0;
  await assert.rejects(managedRequest(call, "stop", {}, { ...time,
    readSettlement: () => {
      if (time.now() >= 20) throw managedControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN", "Durable write is uncertain");
      return null;
    },
    request: async () => { requests++; throw unavailable(); },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
    assert.equal(error.primaryCause.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.elapsedMs, 20);
    assert.equal(error.communication.attempts.length, 1);
    return true;
  });
  assert.equal(requests, 1);
});

test("verified refusal takes precedence over a concurrent execution deadline", async () => {
  const time = clock();
  await assert.rejects(managedRequest(call, "start", {}, { ...time, deadline: 10,
    request: async () => { time.advance(10); throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Request differs"); },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_REQUEST_MISMATCH");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.attempts[0].outcome, "refused");
    return true;
  });
});

test("an authoritative acceptance read failure retains the exhausted communication history", async () => {
  const time = clock();
  await assert.rejects(managedRequest(call, "start", {}, { ...time,
    readAcceptance: () => { throw managedControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN", "Acceptance write is uncertain"); },
    request: async () => { throw unavailable(); },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
    assert.equal(error.primaryCause.code, "PROCESS_EXECUTION_DURABILITY_UNCERTAIN");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.acceptance, "unknown");
    assert.equal(error.communication.elapsedMs, 14000);
    assert.equal(error.communication.attempts.length, 3);
    return true;
  });
});

test("verified request mismatch is retained after inspecting the same call's durable completion", async () => {
  const time = clock();
  const terminal = { ...call, state: "finished", outcome: { code: 0 } };
  let reads = 0;
  let requests = 0;
  await assert.rejects(managedRequest(call, "start", {}, { ...time,
    readSettlement: () => ++reads === 1 ? null : terminal,
    request: async () => {
      requests++;
      throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "A different request was accepted");
    },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_REQUEST_MISMATCH");
    assert.equal(error.primaryCause.code, "PROCESS_EXECUTION_REQUEST_MISMATCH");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.communication.acceptance, "rejected");
    assert.equal(error.communication.elapsedMs, 0);
    assert.equal(error.communication.attempts.length, 1);
    return true;
  });
  assert.equal(reads, 2);
  assert.equal(requests, 1);
  assert.equal(time.now(), 0);
});

test("a verified authority refusal remains primary when later acceptance observation fails", async () => {
  const time = clock();
  const later = managedControlFailure("PROCESS_EXECUTION_DURABILITY_UNCERTAIN", "Later acceptance observation is uncertain");
  await assert.rejects(managedRequest(call, "status", {}, { ...time,
    readAcceptance: () => { throw later; },
    request: async () => { throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Response belongs to another execution"); },
  }), (error) => {
    assert.equal(error.code, "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
    assert.equal(error.primaryCause.code, "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
    assert.equal(error.communication.acceptance, "unknown");
    assert.equal(error.communication.cutoff, "refused");
    assert.equal(error.cause.cause instanceof AggregateError, true);
    assert.equal(error.cause.cause.errors.includes(later), true);
    return true;
  });
});

test("authoritative failure before transmission preserves its existing typed evidence", async () => {
  const original = managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "Launcher membership cannot be observed").withContext(call);
  const stored = original.toJSON();
  let requests = 0;
  await assert.rejects(managedRequest(call, "status", {}, {
    readSettlement: () => { throw original; },
    request: async () => { requests++; return { state: "running" }; },
  }), (error) => {
    assert.deepEqual(error.toJSON(), stored);
    assert.equal(error.communication, null);
    assert.equal(error.executionId, call.executionId);
    assert.equal(error.callId, call.callId);
    return true;
  });
  assert.equal(requests, 0);
  assert.deepEqual(original.toJSON(), stored);
});

for (const absoluteDeadline of [Infinity, 5000]) {
  test(`communication callback deadlines follow the response slots clipped by ${absoluteDeadline}`, async () => {
    const time = clock();
    const activeDeadlines = [];
    const outputDeadlines = [];
    const settlementDeadlines = [];
    const acceptanceDeadlines = [];
    let waits = 0;
    const effectiveDeadline = Math.min(14000, absoluteDeadline);
    await assert.rejects(managedRequest(call, "status", {}, { ...time, deadline: absoluteDeadline,
      onWait: (deadline) => { outputDeadlines.push(deadline); },
      readSettlement: (deadline) => { settlementDeadlines.push(deadline); return null; },
      readAcceptance: (_message, deadline) => { acceptanceDeadlines.push(deadline); return "unknown"; },
      wait: async () => { waits++; },
      request: async (_call, _message, { timeoutMs, onWait, readSettlement }) => {
        onWait();
        readSettlement();
        activeDeadlines.push(outputDeadlines.at(-1));
        time.advance(timeoutMs);
        throw unavailable();
      },
    }), (error) => {
      assert.equal(error.communication.elapsedMs, effectiveDeadline);
      assert.equal(error.communication.cutoff, absoluteDeadline === Infinity ? "budget-exhausted" : "operation-deadline");
      return true;
    });
    assert.deepEqual(activeDeadlines, absoluteDeadline === Infinity ? [2000, 6000, 14000] : [2000, 5000]);
    assert.deepEqual(outputDeadlines, settlementDeadlines);
    assert.equal(outputDeadlines.every((deadline) => deadline <= effectiveDeadline), true);
    assert.deepEqual(acceptanceDeadlines, [effectiveDeadline]);
    assert.equal(time.now(), effectiveDeadline);
    assert.equal(waits, 0);
  });
}

test("acceptance inspection after a verified refusal uses the current response deadline", async () => {
  const time = clock();
  const deadlines = [];
  await assert.rejects(managedRequest(call, "status", {}, { ...time,
    readAcceptance: (_message, deadline) => { deadlines.push(deadline); return "unknown"; },
    request: async () => { throw managedControlFailure("PROCESS_EXECUTION_AUTHORITY_MISMATCH", "Wrong response authority"); },
  }), { code: "PROCESS_EXECUTION_AUTHORITY_MISMATCH" });
  assert.deepEqual(deadlines, [2000]);
  assert.equal(time.now(), 0);
});
