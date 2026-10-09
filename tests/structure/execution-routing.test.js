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
      '["draft-questions", "draft-coverage", "spec", "test", "impl"].includes(persistedPhase)',
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

test("additional registered phases retain complete lookup, immutable selection, and displayed projection", () => {
  const mutations = [
    ["src/flow/engine/composition/registered-step-execution.js",
      "requirementTestStepRegistration(stepId) ?? prepareStepRegistration(stepId)",
      "requirementTestStepRegistration(stepId)", "A10"],
    ["src/flow/engine/composition/registered-step-execution.js",
      'flowLeafIdsBetween("branch", "report")', 'flowLeafIdsBetween("draft", "report")', "A11"],
    ["src/flow/lib/run-dispatch.js",
      'selectedRegistration?.executionContract.selectorName === "selectPrepareExecutionAdmission"',
      'stepId !== "branch" && selectedRegistration?.executionContract.selectorName === "selectPrepareExecutionAdmission"', "A10"],
    ["src/flow/lib/run-dispatch.js",
      "return executeSelectedPrepareStepExecution({ ctx, stepId, selection });",
      "selection = null; return executeSelectedPrepareStepExecution({ ctx, stepId, selection });", "A10"],
    ["src/flow/lib/run-dispatch.js",
      "return executeSelectedPrepareStepExecution({ ctx, stepId, selection });",
      "return executeSelectedPrepareStepExecution({ ctx, stepId, selection: null });", "A10"],
    ["src/flow/lib/get-next-action.js",
      'target.scope === "flow" && prepareStepRegistration(target.stepId) !== null',
      'target.scope === "flow" && target.stepId !== "branch" && prepareStepRegistration(target.stepId) !== null', "A10"],
    ["src/flow/lib/get-next-action.js",
      "let selectedDirective = preparationDirective ?? (specPostFailure === null",
      "let selectedDirective = null ?? (specPostFailure === null", "A10"],
  ];
  for (const [file, before, after, expectedRule] of mutations) {
    const source = original.get(file);
    assert.equal(source.includes(before), true, `${file} valid producer shape exists`);
    const files = new Map(original);
    files.set(file, source.replace(before, after));
    const report = inspect(files);
    const diagnostic = report.diagnostics.find((entry) => entry.rule === expectedRule && entry.file === file);
    assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
    assert.equal(diagnostic.line > 0 && diagnostic.column > 0, true);
    assert.equal(diagnostic.trace.includes(file), true);
  }
  const displayFile = "src/flow/lib/get-next-action.js";
  const source = original.get(displayFile);
  const projection = 'const preparationDirective = target.scope === "flow" && prepareStepRegistration(target.stepId) !== null\n'
    + '    ? projectPrepareStepExecution({ ctx, stepId: target.stepId }) : null;';
  assert.equal(source.includes(projection), true);
  const removed = new Map(original);
  removed.set(displayFile, source.replace(projection, "const preparationDirective = null;")
    .replace("let selectedDirective = preparationDirective ?? (specPostFailure === null",
      "let selectedDirective = (specPostFailure === null"));
  const missingProjection = inspect(removed).diagnostics.find((entry) => entry.rule === "A10"
    && entry.file === displayFile && entry.message === "canonical registered phase display lacks its named projection");
  assert.ok(missingProjection);
  assert.equal(missingProjection.line > 0 && missingProjection.column > 0, true);
  assert.equal(missingProjection.trace.includes(displayFile), true);
  const dispatchFile = "src/flow/lib/run-dispatch.js";
  const dispatchSource = original.get(dispatchFile);
  const registeredPhaseBranch = '    const selectedRegistration = flowStepExecutionRegistration(stepId);\n'
    + '    if (selectedRegistration?.executionContract.selectorName === "selectPrepareExecutionAdmission") {\n'
    + '      const selection = selectedRegistration.executionContract.select({ ctx, stepId, registration: selectedRegistration });\n'
    + '      return executeSelectedPrepareStepExecution({ ctx, stepId, selection });\n'
    + '    }\n';
  assert.equal(dispatchSource.includes(registeredPhaseBranch), true);
  const removedDispatch = new Map(original);
  removedDispatch.set(dispatchFile, dispatchSource.replace(registeredPhaseBranch, ""));
  const missingExecutionReport = inspect(removedDispatch);
  const missingExecution = missingExecutionReport.diagnostics.find((entry) => entry.rule === "A10"
    && entry.file === dispatchFile && entry.message === "worker execution entry bypasses registered selection");
  assert.ok(missingExecution, missingExecutionReport.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(missingExecution.line > 0 && missingExecution.column > 0, true);
  assert.equal(missingExecution.trace.includes(dispatchFile), true);
  const restored = inspect(original);
  assert.equal(restored.ok, true, restored.diagnostics.map((entry) => entry.toString()).join("\n"));
});

for (const [kind, file, before, after, originalName, renamedName] of [
    ["display", "src/flow/lib/get-next-action.js",
      "function buildCanonicalNextActionResult(ctx, state, typedState",
      "function buildCanonicalNextActionResult(renamedPhaseProjection, ctx, state, typedState",
      "projectPrepareStepExecution", "renamedPhaseProjection"],
    ["dispatch", "src/flow/lib/run-dispatch.js",
      "async runWorkerAttempt(ctx, invocation, retryFeedback = null, agentOverride = null) {",
      "async runWorkerAttempt(ctx, invocation, retryFeedback = null, agentOverride = null, renamedPhaseExecution) {",
      "executeSelectedPrepareStepExecution", "renamedPhaseExecution"],
]) {
  test(`additional registered phase ${kind} terminal retains its module binding identity after renaming`, () => {
    const source = original.get(file).replaceAll(originalName, renamedName);
    assert.equal(source.includes(before), true);
    const files = new Map(original);
    files.set(file, source);
    const renamed = inspect(files);
    assert.equal(renamed.ok, true, renamed.diagnostics.map((entry) => entry.toString()).join("\n"));
    files.set(file, source.replace(before, after));
    const report = inspect(files);
    const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === file);
    assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
    assert.equal(diagnostic.line > 0 && diagnostic.column > 0, true);
    assert.equal(diagnostic.trace.includes(file), true);
    files.set(file, source);
    const restored = inspect(files);
    assert.equal(restored.ok, true, restored.diagnostics.map((entry) => entry.toString()).join("\n"));
  });
}
