import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { AgentFileInputFailure } from "../../../src/lib/agent-file-input-failure.js";
import { TemporaryAgentFileInput } from "../../../src/lib/agent-file-reference.js";
import { flowTemporaryRoot, resolveFlowContext } from "../../../src/flow/lib/flow-context.js";
import { checkGuardrail } from "../../../src/flow/lib/run-gate.js";
import { ReviewTextPromptPlan } from "../../../src/flow/lib/review-text-prompt-plan.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const guardrail = { id: "COMPLETE", title: "Complete input", body: "Read the entire authority.",
  meta: { phase: ["draft"], category: "requirements" } };
const completeText = `HEAD\n${"あ".repeat(130000)}\nTAIL`;

function repository(t) {
  const root = fixtureRepository("temporary-input-scope-");
  t.after(() => removeTmpDir(root));
  return root;
}

// Outcome: a complete judgment uses only the exact selected Flow's bytes.
// Producer: canonical create/register -> public exact selection -> Gate input.
// The external provider is the sole fake, and observes both concurrent files.
test("exact Flow selection keeps simultaneous Gate inputs in separate spec/run scopes", async (t) => {
  const root = repository(t);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const identities = [{ specId: "scope-a", runId: "run-a" }, { specId: "scope-b", runId: "run-b" }];
  for (const identity of identities) new CanonicalFlowFixture({ flowManager: manager, ...identity })
    .create().registerActive();
  const commandContainer = dispatchContainer({ root, flowManager: manager, agent: null });
  const contexts = identities.map(({ specId, runId }) => resolveFlowContext(commandContainer,
    { input: { expectSpec: specId, expectRunId: runId } }));
  const observed = [];
  let release;
  const bothInputs = new Promise((resolve) => { release = resolve; });
  const results = await Promise.all(contexts.map((ctx, index) => checkGuardrail(ctx.executionRoot,
    `${index}:${completeText}`, "draft", undefined, [], {
      projectRoot: ctx.repositoryRoot,
      invocationOptions: { temporaryRoot: flowTemporaryRoot(ctx), executionWorkDir: ctx.executionRoot },
      loadGuardrails: () => [guardrail],
      agent: { resolve: () => true, async call(prompt, options) {
        const file = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
        assert.ok(file);
        const identity = identities[index];
        const scope = path.join(root, ".tmp", "flows", identity.specId, identity.runId);
        assert.equal(options.temporaryRoot, scope);
        assert.equal(options.executionWorkDir, root);
        assert.equal(path.dirname(path.dirname(file)), scope);
        assert.equal(fs.readFileSync(file, "utf8"), `${index}:${completeText}`);
        observed.push(file);
        if (observed.length === 2) release();
        await bothInputs;
        assert.equal(observed.every((input) => fs.existsSync(input)), true);
        return '{"observations":[],"evaluationUnavailable":null}';
      } },
    })));
  assert.deepEqual(results.map((result) => result.passed), [true, true]);
  assert.equal(new Set(observed).size, 2);
  assert.equal(observed.some((file) => fs.existsSync(file)), false);
  for (const identity of identities) assert.deepEqual(fs.readdirSync(path.join(root, ".tmp", "flows", identity.specId, identity.runId)), []);
});

test("linked checkout Review reads exact input from canonical repository storage", (t) => {
  const root = repository(t);
  const checkout = path.join(root, "linked");
  execFileSync("git", ["-C", root, "worktree", "add", checkout, "-b", "scope-linked"], { stdio: "ignore" });
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  new CanonicalFlowFixture({ flowManager: manager, specId: "scope-linked", runId: "run-linked" })
    .create().registerActive();
  const ctx = resolveFlowContext(dispatchContainer({ root, flowManager: manager, agent: null }),
    { input: { expectSpec: "scope-linked", expectRunId: "run-linked" } });
  const plan = ReviewTextPromptPlan.create({ request: completeText, maxChars: 6000,
    projectRoot: root, temporaryRoot: flowTemporaryRoot(ctx) });
  t.after(() => plan.dispose());
  const reference = plan.fileInput.reference;
  assert.equal(reference.projectRoot, root);
  assert.equal(fs.readFileSync(reference.absolutePath, "utf8"), completeText);
  assert.equal(path.resolve(reference.projectRoot, reference.projectRelativePath), reference.absolutePath);
  assert.equal(reference.absolutePath.startsWith(`${checkout}${path.sep}`), false);
  fs.writeFileSync(reference.absolutePath, "changed");
  assert.throws(() => plan.fileInput.assertUnchanged(), AgentFileInputFailure);
});

test("preparing storage stays independent and invalid selected Flow identity stops before writing", (t) => {
  const root = repository(t);
  const preparing = { repositoryRoot: root, flowState: null, preparingFlowState: { runId: "preparing-run" } };
  assert.equal(flowTemporaryRoot(preparing), path.join(root, ".tmp", "runtime", "flow"));
  for (const runId of [undefined, "../outside"]) {
    assert.throws(() => flowTemporaryRoot({ repositoryRoot: root, specId: "scope",
      flowState: { specId: "scope", runId } }), /runId/);
  }
  assert.equal(fs.existsSync(path.join(root, ".tmp", "flows")), false);
  const external = path.join(root, "outside");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "untouched"), "original");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  fs.symlinkSync(external, path.join(root, ".tmp", "escape"));
  assert.throws(() => TemporaryAgentFileInput.create({ projectRoot: root,
    runtimeRoot: path.join(root, ".tmp", "escape"), logicalName: "input.txt", text: completeText }), AgentFileInputFailure);
  assert.deepEqual(fs.readdirSync(external), ["untouched"]);
  assert.equal(fs.readFileSync(path.join(external, "untouched"), "utf8"), "original");
});
