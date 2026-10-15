import assert from "node:assert/strict";
import { test } from "node:test";
import { ExponentialBackoffPolicy } from "../../src/lib/exponential-backoff.js";
import { AgentProviderRetryPolicy } from "../../src/lib/agent.js";
import { ReviewProtocolAttempt, ReviewProtocolTransportAttempt, ReviewProtocolTransportRetryPolicy } from "../../src/flow/lib/review-protocol.js";

test("bounded exponential times preserve the 2/4/8 second communication budget", () => {
  const policy = new ExponentialBackoffPolicy({ initialMs: 2000, attemptCount: 3 });
  assert.deepEqual([1, 2, 3].map((number) => policy.valueAt(number)), [2000, 4000, 8000]);
  assert.equal(policy.totalMs, 14000);
  assert.equal(Object.isFrozen(policy), true);
  for (const number of [0, 4, 1.5, Infinity]) assert.throws(() => policy.valueAt(number), TypeError);
});

test("disabled, constant and fractional-factor policies retain finite exact values", () => {
  const disabled = new ExponentialBackoffPolicy({ initialMs: 1, attemptCount: 0 });
  assert.equal(disabled.totalMs, 0);
  assert.throws(() => disabled.valueAt(1), TypeError);
  const constant = new ExponentialBackoffPolicy({ initialMs: 7, factor: 1, attemptCount: 3 });
  assert.equal(constant.totalMs, 21);
  assert.equal(constant.valueAt(3), 7);
  const fractional = new ExponentialBackoffPolicy({ initialMs: 3, factor: 1.5, attemptCount: 3 });
  assert.equal(fractional.valueAt(3), 6.75);
  assert.equal(fractional.totalMs, 14.25);
});

test("invalid inputs and finite-value or total-budget overflow are refused", () => {
  for (const options of [
    { initialMs: 0 }, { initialMs: Infinity }, { initialMs: 0.5 },
    { factor: 0.5 }, { factor: Infinity }, { attemptCount: -1 }, { attemptCount: 1.5 },
    { initialMs: Number.MAX_SAFE_INTEGER, attemptCount: 2 },
    { factor: Number.MAX_VALUE, attemptCount: 3 },
  ]) assert.throws(() => new ExponentialBackoffPolicy({ initialMs: 1, attemptCount: 3, ...options }), TypeError);
});

test("provider and review policies keep their own retry limits and share the same time values", () => {
  const options = { retryCount: 3, retryDelayMs: 3, backoffFactor: 1.5 };
  const provider = new AgentProviderRetryPolicy(options);
  const review = new ReviewProtocolTransportRetryPolicy(options);
  const protocolAttempt = new ReviewProtocolAttempt({ number: 1, cacheMode: "default" });
  for (const [index, expected] of [3, 4.5, 6.75].entries()) {
    assert.equal(provider.delayBeforeRetry(index + 1), expected);
    assert.equal(review.delayBeforeRetry(new ReviewProtocolTransportAttempt({ protocolAttempt, transportNumber: index + 1 })), expected);
  }
  assert.deepEqual(provider.toJSON(), { retryCount: 3, retryDelayMs: 3 });
  assert.throws(() => provider.delayBeforeRetry(4), /outside its bounded policy/);
  const last = new ReviewProtocolTransportAttempt({ protocolAttempt, transportNumber: 4 });
  assert.equal(review.canRetry({ retryable: true }, last), false);
  assert.equal(review.canRetry({ retryable: false }, new ReviewProtocolTransportAttempt({ protocolAttempt, transportNumber: 1 })), false);
  assert.throws(() => review.delayBeforeRetry(last), /outside its bounded policy/);
});
