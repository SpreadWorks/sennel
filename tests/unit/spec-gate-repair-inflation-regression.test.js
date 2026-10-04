import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { specRepairTargetEntries } from "../../src/flow/lib/spec-repair-operations.js";
import { specGateRepairInflationFixture } from "./spec-gate-repair-inflation-fixture.js";

test("six findings and twenty-four captured sources require only entity-local bodies and canonical evidence", (t) => {
  const input = specGateRepairInflationFixture();
  const context = new SpecGateRepairContext(input);
  const selections = context.units().map((unit) => context.select(unit.id).toJSON());
  assert.equal(input.sources.length, 24);
  assert.equal(input.findings.length, 6);
  assert.equal(selections.length, 4);
  const capturedSourceContentBytes = input.sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.content, "utf8"), 0);
  const requiredReadCharacters = JSON.stringify(selections).length;
  t.diagnostic(`capturedSourceContentBytes=${capturedSourceContentBytes}; requiredReadCharacters=${requiredReadCharacters}; units=${selections.length}`);
  const canonical = input.sources.filter((source) => !source.id.startsWith("evidence:source:"));
  const originalTargets = new Map(specRepairTargetEntries(input.spec).map((entry) => [JSON.stringify(entry.target.toJSON()), entry]));
  const seenFindings = new Set();
  const unintendedBodies = new Set();
  for (const selection of selections) {
    assert.equal(selection.baseRevision, input.baseRevision);
    assert.deepEqual(selection.guardrails, input.guardrails);
    assert.equal(selection.acknowledgedRationale, input.acknowledgedRationale);
    for (const finding of selection.unit.findings) {
      const original = input.findings.find((entry) => JSON.stringify(entry.identity) === JSON.stringify(finding.identity));
      assert(original);
      assert.deepEqual(finding.identity, original.identity);
      assert.deepEqual(finding.targets, original.targets);
      assert.deepEqual(finding.allowedTargets, original.allowedTargets);
      assert.equal(finding.observed, original.observed);
      seenFindings.add(JSON.stringify(finding.identity));
    }
    for (const source of canonical) {
      const range = selection.ranges.find((entry) => entry.id === source.id);
      assert(range);
      assert.equal(range.value.content, source.content);
      assert.equal(range.value.origin, source.origin);
      assert.equal(range.value.revision, source.revision);
      assert.equal(range.digest, source.digest);
      assert.equal(range.writable, false);
      assert.equal(range.target, null);
    }
    const writable = selection.ranges.filter((range) => range.writable);
    assert.deepEqual(writable.map((range) => range.id), selection.unit.rangeIds);
    for (const range of writable) {
      assert.equal(range.digest, originalTargets.get(JSON.stringify(range.target)).digest);
      assert.equal(range.value, input.spec.requirements.find((entry) => entry.id === range.target.id).desc);
    }
    if (selection.ranges.some((range) => range.id.startsWith("evidence:source:"))) unintendedBodies.add("optional source bodies");
    if (selection.ranges.some((range) => range.id.startsWith("tasks["))) unintendedBodies.add("linked task bodies");
    if (selection.ranges.some((range) => range.id.startsWith("overview.decisions["))) unintendedBodies.add("unselected decisions");
    const targetIds = new Set(selection.unit.findings.flatMap((finding) => finding.targets.map((target) => target.id)));
    if (selection.ranges.some((range) => range.entity?.startsWith("requirements:") && !targetIds.has(range.entity.split(":")[1]))) {
      unintendedBodies.add("transitive requirement bodies");
    }
    for (const targetId of targetIds) {
      assert.equal(selection.ranges.find((range) => range.id === `requirements[${targetId}].task_ids[0]`).value, "T1");
    }
  }
  assert.equal(seenFindings.size, 6);
  assert.deepEqual([...unintendedBodies].sort(), [], "unselected bodies must not inflate mandatory input");
});
