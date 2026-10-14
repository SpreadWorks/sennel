import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Envelope } from "../../../src/lib/flow-envelope.js";
import { RunReviewCommand } from "../../../src/flow/lib/run-review.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

class BlockingReviewCommand extends RunReviewCommand {
  constructor() {
    super();
    this.calls = 0;
    this.entered = new Promise((resolve) => { this.notifyEntered = resolve; });
    this.release = new Promise((resolve) => { this.unblock = resolve; });
  }

  async executeCanonical() {
    this.calls += 1;
    if (this.calls === 1) {
      this.notifyEntered();
      await this.release;
    }
    return Envelope.ok("run", "review", { providerExecution: this.calls });
  }
}

function reviewContext(root) {
  const specId = "review-admission-spec";
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: "review-admission-run",
  }).create().registerActive().activate("spec-review");
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    phase: "spec",
    specId,
    flowState: flowManager.loadReadOnly(specId),
    flowManager,
  };
}

describe("RunReviewCommand execution admission", () => {
  it("admits one provider execution when direct and dispatcher review calls overlap", async () => {
    const root = createTmpDir("run-review-execution-admission-");
    roots.push(root);
    const command = new BlockingReviewCommand();
    const ctx = reviewContext(root);
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root,
      runId: ctx.flowState.runId, specId: ctx.specId });
    try {
      // A dispatcher owns one physical execution. Both calls borrow it before
      // testing the inner run/node/Attempt lease; foreign checkout callers are
      // refused earlier by physical admission.
      await runtime.enter(async () => {
        const direct = command.execute(ctx);
        await command.entered;
        let completed;
        try {
          const dispatched = await command.execute({
            ...ctx,
            flowState: ctx.flowManager.loadReadOnly(ctx.specId),
          });
          assert.equal(dispatched.ok, false);
          assert.equal(dispatched.errors[0].code, "REVIEW_EXECUTION_BUSY");
          assert.equal(command.calls, 1);
        } finally { command.unblock(); completed = await direct; }
        assert.equal(completed.ok, true);
        assert.equal(command.calls, 1);
      });
    } finally { await runtime.close(); }
  });
});
