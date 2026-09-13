import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";

const SENNEL = path.resolve("src/sennel.js");

describe("canonical next-action policy projection", () => {
  let root = null;
  afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

  it("does not project the retired mutable autoUpgrade cache", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-next-action-policy-"));
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify({
      lang: "ja",
      type: "base",
      docs: { languages: ["ja"], defaultLanguage: "ja" },
    }));
    const flowManager = makeFlowManager(root);
    new FlowAtStepFixture({
      flowManager,
      specId: "001-test",
      runId: "run-next-action-policy",
      request: "Create canonical test sources.",
      targetStep: "draft",
      specRecord: { goal: "test fixture", requirements: [] },
    }).create();

    const result = spawnSync("node", [SENNEL, "flow", "get", "next-action"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: root },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.autoUpgrade, undefined);
    assert.equal(flowManager.loadReadOnly("001-test").autoUpgrade, undefined);
  });
});
