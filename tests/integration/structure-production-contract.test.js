import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { draftStepRegistrations } from "../../src/flow/engine/composition/draft.js";
import { specStepRegistrations } from "../../src/flow/engine/composition/spec.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { checkStructure } from "../support/structure/checker.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function copyProductionSource(t) {
  const root = createTmpDir("structure-production-contract-");
  t.after(() => removeTmpDir(root));
  fs.cpSync(path.join(sourceRoot, "src"), path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

function checkPhase(root, phase) {
  return checkStructure({
    root,
    entry: `src/flow/steps/${phase}`,
    registrations: phase === "draft" ? draftStepRegistrations : specStepRegistrations,
  });
}

function assertClean(report) {
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

function assertViolation(report, rule, file, line) {
  assert.ok(report.diagnostics.some((entry) => entry.rule === rule
    && entry.file === file && entry.line === line && entry.column > 0),
  `Expected ${rule} at ${file}:${line}; diagnostics:\n`
    + report.diagnostics.map((entry) => entry.toString()).join("\n"));
}

function lineOfUnique(root, file, text) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const first = source.indexOf(text);
  assert.ok(first >= 0 && source.indexOf(text, first + text.length) < 0,
    `${file} must contain one location target`);
  return source.slice(0, first).split("\n").length;
}

function replaceOnce(root, file, before, after) {
  const target = path.join(root, file);
  const original = fs.readFileSync(target, "utf8");
  assert.equal(original.split(before).length, 2, `${file} must contain one mutation target`);
  fs.writeFileSync(target, original.replace(before, after));
  return () => fs.writeFileSync(target, original);
}

test("copied production Draft rejects a broad Service argument and recovers after removal", (t) => {
  const root = copyProductionSource(t);
  assertClean(checkPhase(root, "draft"));
  const file = "src/flow/engine/composition/draft.js";
  const line = lineOfUnique(root, file, "return [observed, writer];");
  const restore = replaceOnce(root, file, "return [observed, writer];", "return [ctx, writer];");
  assertViolation(checkPhase(root, "draft"), "A12", file, line);
  restore();
  assertClean(checkPhase(root, "draft"));
});

test("copied production worker entry rejects discarding its registered selection", (t) => {
  const root = copyProductionSource(t);
  assertClean(checkPhase(root, "spec"));
  const file = "src/flow/lib/run-dispatch.js";
  const selectionLine = lineOfUnique(root, file,
    "const selection = registration.executionContract.select({ ctx, stepId });");
  const restore = replaceOnce(root, file,
    "return registration.executionContract.execute(selection, {\n"
      + "      command: this, ctx, invocation, retryFeedback, agentOverride,\n"
      + "    });",
    "return this.#executeSelectedWorker(ctx, invocation, retryFeedback, agentOverride);");
  assertViolation(checkPhase(root, "spec"), "A10", file, selectionLine);
  restore();
  assertClean(checkPhase(root, "spec"));
});

test("copied production Gate rejects a public canonical bypass of admission", (t) => {
  const root = copyProductionSource(t);
  assertClean(checkPhase(root, "draft"));
  const file = "src/flow/lib/run-gate.js";
  const line = lineOfUnique(root, file,
    "async executeCanonical(ctx, { phase } = {}) {");
  const restore = replaceOnce(root, file,
    "return this.execute({ ...ctx, ...(phase === undefined ? {} : { phase }) });",
    "return this.#executeCanonical(ctx, { phase });");
  assertViolation(checkPhase(root, "draft"), "A11", file, line);
  restore();
  assertClean(checkPhase(root, "draft"));
});

test("copied production Gate display rejects discarding only its registered projection", (t) => {
  const root = copyProductionSource(t);
  assertClean(checkPhase(root, "draft"));
  const file = "src/flow/lib/get-next-action.js";
  const selectionLine = lineOfUnique(root, file,
    "const selection = registration.executionContract.select({\n"
      + "      flowManager: ctx.flowManager, flowState: state, phase,");
  const restore = replaceOnce(root, file,
    "return registration.executionContract.project(selection);",
    "return selection.action;");
  assertViolation(checkPhase(root, "draft"), "A10", file, selectionLine);
  restore();
  assertClean(checkPhase(root, "draft"));
});

test("copied production rejects excluding one registered worker from shared display judgment", (t) => {
  const root = copyProductionSource(t);
  const file = "src/flow/lib/get-next-action.js";
  const original = 'const workerRegistration = target.scope === "flow"';
  const line = lineOfUnique(root, file, original);
  for (const [phase, stepId] of [["spec", "spec-gate-repair"], ["draft", "draft-refine"]]) {
    assertClean(checkPhase(root, phase));
    const restore = replaceOnce(root, file, original,
      `${original} && target.stepId !== ${JSON.stringify(stepId)}`);
    try {
      assertViolation(checkPhase(root, phase), "A10", file, line);
    } finally {
      restore();
    }
    assertClean(checkPhase(root, phase));
  }
});

test("copied production rejects a single worker execution branch before shared judgment", (t) => {
  const root = copyProductionSource(t);
  const file = "src/flow/lib/run-dispatch.js";
  const entry = "async runWorkerAttempt(ctx, invocation, retryFeedback = null, agentOverride = null) {";
  const line = lineOfUnique(root, file, entry);
  assertClean(checkPhase(root, "spec"));
  const restore = replaceOnce(root, file, entry, `${entry}\n`
    + '    if (invocation.action.nextAction.step === "spec-gate-repair") {\n'
    + "      return this.#executeSelectedWorker(ctx, invocation, retryFeedback, agentOverride);\n"
    + "    }");
  try {
    assertViolation(checkPhase(root, "spec"), "A10", file, line);
  } finally {
    restore();
  }
  assertClean(checkPhase(root, "spec"));
});

test("copied production rejects hiding a registered worker in its lookup", (t) => {
  const root = copyProductionSource(t);
  const file = "src/flow/engine/composition/spec.js";
  const entry = "export function specWorkerStepRegistration(stepId) {";
  const line = lineOfUnique(root, file, entry);
  assertClean(checkPhase(root, "spec"));
  const restore = replaceOnce(root, file, entry,
    `${entry} if (stepId === "spec-gate-repair") return null;`);
  try {
    assertViolation(checkPhase(root, "spec"), "A10", file, line);
  } finally {
    restore();
  }
  assertClean(checkPhase(root, "spec"));
});

test("copied production rejects an additional public entry to the private worker", (t) => {
  const root = copyProductionSource(t);
  const file = "src/flow/lib/run-dispatch.js";
  const entry = "async runWorkerAttempt(ctx, invocation, retryFeedback = null, agentOverride = null) {";
  assertClean(checkPhase(root, "spec"));
  const restore = replaceOnce(root, file, entry,
    "async bypassRegisteredWorker(ctx, invocation) {\n"
      + "    return this.#executeSelectedWorker(ctx, invocation, null, null);\n"
      + `  }\n\n  ${entry}`);
  const line = lineOfUnique(root, file,
    "return this.#executeSelectedWorker(ctx, invocation, null, null);");
  try {
    assertViolation(checkPhase(root, "spec"), "A11", file, line);
  } finally {
    restore();
  }
  assertClean(checkPhase(root, "spec"));
});

test("copied production rejects Service reads through an instantiated helper", (t) => {
  const root = copyProductionSource(t);
  const serviceFile = "src/flow/services/spec-service.js";
  const helperFile = "src/flow/lib/input-reader.js";
  assertClean(checkPhase(root, "spec"));
  fs.writeFileSync(path.join(root, helperFile),
    "import fs from 'node:fs';\n"
    + "export class InputReader { obtain() { return fs.readFileSync('input'); } }\n");
  const restore = replaceOnce(root, serviceFile,
    'import { StepResult } from "../engine/step-result.js";',
    'import { StepResult } from "../engine/step-result.js";\n'
      + 'import { InputReader } from "../lib/input-reader.js";');
  const restoreMethod = replaceOnce(root, serviceFile,
    "inspectWorkerCompletion() { return this.#input.facts; }",
    "inspectWorkerCompletion() { const reader = new InputReader(); return reader.obtain(); }");
  try {
    assertViolation(checkPhase(root, "spec"), "A08", helperFile, 1);
  } finally {
    restoreMethod();
    restore();
    fs.unlinkSync(path.join(root, helperFile));
  }
  assertClean(checkPhase(root, "spec"));
});

test("copied production rejects Writer reads whose names lack a read prefix", (t) => {
  const root = copyProductionSource(t);
  const file = "src/flow/services/spec-review-settlement-writer.js";
  assertClean(checkPhase(root, "spec"));
  for (const read of [
    "this.#flowManager.artifactCatalog('spec');",
    'this.#flowManager["artifactCatalog"](this.#binding.specId);',
    "this.#flowManager?.artifactCatalog(this.#binding.specId);",
    "const { artifactCatalog } = this.#flowManager; artifactCatalog.call(this.#flowManager, this.#binding.specId);",
  ]) {
    const restore = replaceOnce(root, file, "settle({ stepResult, settlement }) {",
      `settle({ stepResult, settlement }) {\n    ${read}`);
    const line = lineOfUnique(root, file, read);
    try {
      assertViolation(checkPhase(root, "spec"), "A08", file, line);
    } finally {
      restore();
    }
    assertClean(checkPhase(root, "spec"));
  }
});

for (const [phase, opposite, registrations] of [
  ["draft", "spec", draftStepRegistrations],
  ["spec", "draft", specStepRegistrations],
]) {
  test(`${phase} production registrations load without importing ${opposite} composition`, (t) => {
    const root = copyProductionSource(t);
    fs.writeFileSync(path.join(root, `src/flow/engine/composition/${opposite}.js`),
      `throw new Error("unexpected ${opposite} composition import");\n`);
    const script = `import { ${phase}StepRegistrations } from './src/flow/engine/composition/${phase}.js';\n`
      + `process.stdout.write(JSON.stringify(${phase}StepRegistrations.map((item) => item.stepId)));`;
    const loaded = JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(loaded, registrations.map((registration) => registration.stepId));
  });
}
