import assert from "node:assert/strict";
import { it } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import RunReopenDraftCommand from "../../../src/flow/lib/run-reopen-draft.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

it("returns a failed Spec Gate repair to Draft through the existing reopen command", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const reason = "The user must choose the retention period before revising the Spec.";
    const result = await new RunReopenDraftCommand().execute({ ...value.ctx, reason,
      flowState: value.flowManager.loadReadOnly(value.specId) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    assert.equal(reloaded.canonicalState(value.specId).current.at(-1), "draft");
    const log = reloaded.readArtifact({ specId: value.specId,
      logicalKey: "issue.log", consumerNodeId: "draft" });
    assert.equal(JSON.parse(log.bytes.toString("utf8")).entries.at(-1).draftReopen.reason, reason);
  } finally {
    removeTmpDir(value.root);
  }
});
