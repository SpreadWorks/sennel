import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviousFlowSchemaProjection } from "../../src/lib/flow-schema-migration.js";

test("explicit previous-schema projection preserves semantic state and its historical replay baseline", () => {
  const previous = { schemaRevision: 4, current: ["implement"], attempt: { id: "attempt", sequence: 3 },
    migration: { baseline: { schemaRevision: 4, migration: null, immutableEvidence: ["original"] } } };
  const before = structuredClone(previous);
  const projected = PreviousFlowSchemaProjection.project(previous);
  assert.equal(projected.schemaRevision, 5);
  assert.equal(projected.migration.baseline.schemaRevision, 5);
  assert.deepEqual(projected.current, previous.current);
  assert.deepEqual(projected.attempt, previous.attempt);
  assert.deepEqual(projected.migration.baseline.immutableEvidence, ["original"]);
  assert.deepEqual(previous, before);
});

test("explicit previous-schema projection refuses an unproven replay baseline without changing input", () => {
  const previous = { schemaRevision: 4, migration: { baseline: { schemaRevision: 3 } } };
  const before = structuredClone(previous);
  assert.throws(() => PreviousFlowSchemaProjection.project(previous), /UNSAFE_SOURCE_FORMAT/);
  assert.deepEqual(previous, before);
});
