import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { readSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-input.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { createSpecGateRepairScenario, completeSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

test("repair handoff reads the linked Issue, prior Draft and referenced working-tree source after reload", async () => {
  const value = await createSpecGateRepairScenario({ issue: 42,
    issueSnapshot: "# Requirement\nInclude regression checks for consumers of src/help.js.\n",
    request: "Preserve the shared help contract.",
    beforeGate: ({ root, specId, flowManager, flow }) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/help.js"), "export const render = () => 'help';\n");
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Reuse the existing renderer.\n");
      assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
      assert.equal(runGit(["add", "src/help.js", "AGENTS.md"], { cwd: root }).ok, true);
      flow.activate("draft");
      flowManager.publishCurrentAttemptResult({ specId,
        commandResult: attachCanonicalCommandResultPublications({ result: "draft prepared" }, [{
          logicalKey: "draft", payload: canonicalDraftDocument({ goal: "Preserve existing shared consumers." }),
        }]),
      });
    },
  });
  try {
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    value.ctx.flowManager = reloaded;
    const input = () => readSpecGateRepairInput({ flowManager: reloaded,
      state: reloaded.canonicalState(value.specId), executionRoot: value.root });
    const first = input();
    const selected = first.context.select(first.context.units()[0].id);
    const evidence = new Map(selected.ranges.filter((range) => range.id.startsWith("evidence:"))
      .map((range) => [range.id, range]));
    for (const id of ["evidence:issue.snapshot", "evidence:draft", "evidence:project-rules", "evidence:source:src/help.js"]) {
      assert(evidence.has(id), `canonical repair input must include ${id}`);
    }
    assert.match(evidence.get("evidence:issue.snapshot").value.content, /Include regression checks/);
    assert.match(evidence.get("evidence:draft").value.content, /Preserve existing shared consumers/);
    assert.match(evidence.get("evidence:project-rules").value.content, /Reuse the existing renderer/);
    assert.match(evidence.get("evidence:source:src/help.js").value.content, /export const render/);
    for (const range of evidence.values()) {
      assert.equal(range.writable, false);
      assert.equal(range.target, null);
      assert.match(range.value.revision, /^[a-f0-9]{64}$/);
    }
    fs.writeFileSync(path.join(value.root, "src/help.js"), "export const render = () => 'updated help';\n");
    assert.notEqual(input().context.evidenceDigest, first.context.evidenceDigest);
    const outcome = await completeSpecGateRepairHandoff({ ...value,
      replacement: "Publish a precisely validated artifact." });
    const requestContext = outcome.request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    assert.match(JSON.stringify(requestContext), /Include regression checks/);
    assert.match(JSON.stringify(requestContext), /updated help/);
    assert(["spec-gate-repair-review-required", "spec-gate-repair-ready-for-gate"].includes(outcome.result.kind));
    assert(["spec-review", "spec-gate"].includes(outcome.service.workerOutcome.receipt.targetStepId));
  } finally { removeTmpDir(value.root); }
});
