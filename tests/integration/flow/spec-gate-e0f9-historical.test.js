import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../../src/flow/lib/spec-gate-repair-context.js";

const fixture = JSON.parse(fs.readFileSync(new URL("../../fixtures/spec-gate-e0f9-historical-521.json", import.meta.url), "utf8"));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("retained #521 R10 findings select the exact existing field without location exploration", () => {
  const findings = fixture.observations.map((observation, index) => ({
    ...observation,
    identity: {
      sourceArtifact: "retained-runtime-log/spec-gate.json",
      sourceStep: "spec-gate",
      sourceFindingId: `retained-observation-${index}`,
      fingerprint: digest(observation),
    },
  }));
  const context = new SpecGateRepairContext({
    spec: fixture.spec,
    baseRevision: `sha256:${digest(fixture.spec)}`,
    findings,
    // The historical rule bodies are unavailable. These rule identities only
    // satisfy the context boundary; no rule evaluation is part of this test.
    guardrails: fixture.observations.map(({ requirementRef }) => ({ id: requirementRef })),
  });
  assert.equal(context.unresolvedFindings().length, 0);
  assert.equal(context.units().length, 1);
  const selection = context.select(context.units()[0].id).toJSON();
  assert.deepEqual(selection.unit.rangeIds, [fixture.expectedRangeId]);
  assert.deepEqual(selection.unit.findings.map(({ observed }) => observed), fixture.observations.map(({ observed }) => observed));
  const selected = selection.ranges.find(({ id }) => id === fixture.expectedRangeId);
  assert.equal(selected.value, fixture.spec.requirements[0].desc);
  assert.equal(selected.writable, false, "location resolution must not manufacture repair authority");
});
