import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";
import {
  CanonicalFlowFixture,
  makeFlowManager,
  promoteCanonicalRequirementTest,
} from "../../../support/infrastructure/flow-setup.js";
const FLOW_CMD = join(process.cwd(), "src/sennel.js");
const FLOW_CMD_ARGS_PREFIX = ["flow"];

describe("flow get check impl", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  function createFixture() {
    const manager = makeFlowManager(tmp);
    return new CanonicalFlowFixture({
      flowManager: manager,
      specId: "001-test",
      runId: "status-check",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create();
  }

  it("PASS when approval has skipped an empty Requirement test plan", () => {
    tmp = createTmpDir();
    createFixture().settleBefore("implement").registerActive();
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "check", "impl"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    assert.match(result, /pass.*true/is);
  });

  it("FAIL while a Requirement candidate is awaiting test-review", () => {
    tmp = createTmpDir();
    const manager = makeFlowManager(tmp);
    const fixture = new CanonicalFlowFixture({
      flowManager: manager,
      specId: "001-test",
      runId: "status-check",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      specRecord: { requirements: [{
        id: "R1", desc: "Exercise the Requirement test frontier.", task_ids: ["T1"],
        preimplementation_test_expectation: "fail",
      }] },
    }).create().addTask({
      id: "T1", title: "Fixture Task", goal: "Exercise the Requirement test frontier.",
      origin: "plan", added_round: 0, status: "pending",
    }).registerActive().activate("approval");
    fixture.settle("approval");
    promoteCanonicalRequirementTest({
      flowManager: manager,
      specId: fixture.specId,
      requirementId: "R1",
      completion: "generate",
    });
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "check", "impl"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    assert.match(result, /pass.*false/is);
    assert.match(result, /test-gate/);
  });

  it("returns ok:true with pass:false when no flow.json exists", () => {
    tmp = createTmpDir();
    const result = execFileSync("node", [FLOW_CMD, ...FLOW_CMD_ARGS_PREFIX, "get", "check", "impl"], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.pass, false);
    assert.match(envelope.data.summary, /no active flow/);
  });
});
