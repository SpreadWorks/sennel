import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContextRequest } from "../../src/flow/lib/spec-gate-repair-context-expansion.js";

function canonicalRequest() {
  return { version: 1, stage: "spec-gate-repair-context-request", baseRevision: `sha256:${"a".repeat(64)}`,
    unitId: "repair-unit", additionalRangeIds: ["background"] };
}

test("canonical context request roundtrip retains exact immutable range identities", () => {
  const input = canonicalRequest();
  const request = SpecGateRepairContextRequest.fromJSON(input);
  assert.deepEqual(request.toJSON(), input);
  input.additionalRangeIds.push("goal");
  assert.deepEqual(request.additionalRangeIds, ["background"]);
  const serialized = request.toJSON();
  serialized.additionalRangeIds.push("goal");
  assert.deepEqual(request.toJSON(), canonicalRequest());
  assert.throws(() => request.additionalRangeIds.push("goal"), TypeError);
});

test("context request rejects malformed schema and legacy selector envelopes", () => {
  const input = canonicalRequest();
  const { unitId, ...withoutUnit } = input;
  const invalid = [null, [], withoutUnit, { ...input, version: 3 }, { ...input, intent: "repair" },
    { ...input, sourceOrigins: [] }, { ...input, sourceQueries: [] }, { ...input, unknown: "extra" },
    { ...input, stage: "spec-gate-repair" }, { ...input, baseRevision: "sha256:stale" },
    { ...input, unitId: " " }, { ...input, additionalRangeIds: [] },
    { ...input, additionalRangeIds: ["background", "background"] }, { ...input, additionalRangeIds: [" "] },
    { ...input, additionalRangeIds: [null] }];
  for (const value of invalid) {
    assert.throws(() => SpecGateRepairContextRequest.fromJSON(value), TypeError, JSON.stringify(value));
  }
});

test("checkout origin and line-query requests receive explicit unavailable refusal", () => {
  for (const selector of [{ sourceOrigins: ["src/entry.js"] },
    { sourceQueries: [{ origin: "src/owner.js", literal: "limit", beforeLines: 0, afterLines: 0, maxMatches: 1, cursor: null }] },
    { sourceOrigins: null }, { sourceQueries: "src/owner.js" }]) {
    const value = { ...canonicalRequest(), ...selector };
    const before = structuredClone(value);
    assert.throws(() => SpecGateRepairContextRequest.fromJSON(value), {
      code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE", retryable: false,
    });
    assert.deepEqual(value, before);
  }
});
