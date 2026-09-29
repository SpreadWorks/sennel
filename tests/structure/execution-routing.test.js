import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { specStepRegistrations } from "../../src/flow/engine/composition/spec.js";
import { MemorySourceRepository, SourceRepository } from "../support/structure/source-repository.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const disk = new SourceRepository(root);
const original = new Map(disk.list("src").map((file) => [file, disk.read(file)]));
const scope = new StructureScope(root, "src/flow/steps/spec", specStepRegistrations);

function inspect(files) {
  return new StructureChecker(scope, new MemorySourceRepository(files)).check();
}

test("registered Gate, Review, and display routes reject Step-specific bypasses", () => {
  for (const [file, before, after] of [
    ["src/flow/engine/composition/registered-step-execution.js",
      'if (phase === "spec" || phase === "task-spec")',
      'if (phase === "spec" && phase === "task-spec")'],
    ["src/flow/lib/run-review.js",
      '["draft-questions", "draft-coverage", "spec"].includes(persistedPhase)',
      '["draft-questions", "draft-coverage"].includes(persistedPhase)'],
    ["src/flow/lib/get-next-action.js",
      'const claimDirective = claimRequired',
      'const claimDirective = target.stepId === "spec-gate-repair" ? lifecycleDirective : claimRequired'],
    ["src/flow/lib/get-next-action.js",
      '.withReviewDisposition(reviewDisposition)',
      '.withReviewDisposition(null)'],
    ["src/flow/lib/get-next-action.js",
      '? definitionOwnedGateSelection(ctx, state, target) : null',
      '? target.stepId === "spec-gate" ? null : definitionOwnedGateSelection(ctx, state, target) : null'],
    ["src/flow/lib/get-next-action.js",
      'const gateDirective = definitionOwnedGateDirective(gateSelection, { state, binding });',
      'const gateDirective = target.stepId === "spec-gate" ? null : definitionOwnedGateDirective(gateSelection, { state, binding });'],
    ["src/flow/lib/get-next-action.js",
      'descriptor: definitionDescriptor,',
      'descriptor: target.stepId === "spec-review" ? descriptor : definitionDescriptor,'],
  ]) {
    const source = original.get(file);
    assert.equal(source.includes(before), true, `${file} fixture target exists`);
    const mutated = new Map(original);
    mutated.set(file, source.replace(before, after));
    const report = inspect(mutated);
    assert.equal(report.diagnostics.some((entry) => entry.rule === "A10" && entry.file === file), true,
      report.diagnostics.map((entry) => entry.toString()).join("\n"));
  }
  const restored = inspect(original);
  assert.equal(restored.ok, true, restored.diagnostics.map((entry) => entry.toString()).join("\n"));
});

test("display prose can change without changing registered delegation", () => {
  const file = "src/flow/lib/get-next-action.js";
  const source = original.get(file);
  let changed = source;
  for (const before of [
    "Claim the current Definition-selected action through the canonical Store before starting its worker.",
    "get-next-action is read-only; the explicit claim command rechecks canonical facts immediately before creating the Attempt.",
    "Preserve the recorded reconciliation and inspect the changed input before running Review. Do not reset retry counters or edit evidence.",
  ]) {
    assert.equal(changed.includes(before), true);
    changed = changed.replace(before, "表示文だけを更新しました。");
  }
  const files = new Map(original);
  files.set(file, changed);
  const report = inspect(files);
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  files.set(file, changed.replace('actionId: "CLAIM_NEXT_ACTION"', 'actionId: "OTHER_ACTION"'));
  assert.equal(inspect(files).diagnostics.some((entry) => entry.rule === "A10" && entry.file === file), true);
  assert.equal(inspect(original).ok, true);
});
