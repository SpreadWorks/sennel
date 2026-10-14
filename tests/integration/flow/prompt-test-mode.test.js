import { loadConfig } from "../../../src/lib/config.js";
import { dispatchContainer, dispatchFlowCommand } from "../../support/infrastructure/flow-dispatch-scenario.js";
/**
 * tests/integration/flow/prompt-test-mode.test.js
 *
 * Tests for plan.test-mode prompt update.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";

const FLOW_CMD = join(process.cwd(), "src/flow.js");
const RUNTIME_BOOTSTRAP = join(process.cwd(), "src/sennel.js");

describe("flow get prompt plan.test-mode (reworked)", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function setupFlowState(dir, lang = "en") {
    new CanonicalFlowFixture({ flowManager: makeFlowManager(dir) }).create().registerActive();
    setupFlowConfig(dir, lang);
  }

  it("returns 3 choices: create, skip, other", () => {
    tmp = createTmpDir();
    setupFlowState(tmp);
    const result = execFileSync(
      "node", ["--import", RUNTIME_BOOTSTRAP, FLOW_CMD, "get", "prompt", "plan.test-mode"],
      { encoding: "utf8", env: { ...process.env, SENNEL_WORK_ROOT: tmp } },
    );
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.choices.length, 3);
  });

  it("does not contain unit/e2e choices", async () => {
    tmp = createTmpDir();
    setupFlowState(tmp, "ja");
    const execution = await dispatchFlowCommand({
      container: dispatchContainer({ root: tmp, config: loadConfig(tmp), flowManager: makeFlowManager(tmp) }),
      group: "get", name: "prompt", argv: ["plan.test-mode"], runtimeLog: true,
    });
    assert.equal(execution.exitCode, 0, execution.stderr);
    const envelope = execution.envelope;
    const labels = envelope.data.choices.map((c) => c.label);
    for (const label of labels) {
      assert.ok(!label.includes("ユニットテスト"), `should not contain unit test: ${label}`);
      assert.ok(!label.includes("E2E"), `should not contain E2E: ${label}`);
    }
  });

  it("description asks whether to run tests (not create)", async () => {
    tmp = createTmpDir();
    setupFlowState(tmp, "ja");
    const execution = await dispatchFlowCommand({
      container: dispatchContainer({ root: tmp, config: loadConfig(tmp), flowManager: makeFlowManager(tmp) }),
      group: "get", name: "prompt", argv: ["plan.test-mode"], runtimeLog: true,
    });
    assert.equal(execution.exitCode, 0, execution.stderr);
    const envelope = execution.envelope;
    assert.ok(
      envelope.data.description.includes("実行"),
      `description should ask about running tests, got: ${envelope.data.description}`,
    );
    assert.ok(
      !envelope.data.description.includes("作成"),
      `description should not mention creating tests, got: ${envelope.data.description}`,
    );
  });

  it("choice labels are run/skip (not create/skip)", async () => {
    tmp = createTmpDir();
    setupFlowState(tmp, "ja");
    const execution = await dispatchFlowCommand({
      container: dispatchContainer({ root: tmp, config: loadConfig(tmp), flowManager: makeFlowManager(tmp) }),
      group: "get", name: "prompt", argv: ["plan.test-mode"], runtimeLog: true,
    });
    assert.equal(execution.exitCode, 0, execution.stderr);
    const envelope = execution.envelope;
    const labels = envelope.data.choices.map((c) => c.label);
    assert.ok(
      labels.some((l) => l === "実行する"),
      `choice [1] should be "実行する", got: ${labels[0]}`,
    );
    assert.ok(
      labels.some((l) => l === "実行しない"),
      `choice [2] should be "実行しない", got: ${labels[1]}`,
    );
    assert.ok(
      !labels.some((l) => l.includes("作成")),
      `choices should not mention creating tests, got: ${JSON.stringify(labels)}`,
    );
  });
});
