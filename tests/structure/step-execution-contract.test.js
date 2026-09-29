import assert from "node:assert/strict";
import { test } from "node:test";
import { StepExecutionContract } from "../../src/flow/engine/composition/step-execution-contract.js";

test("one selection is passed unchanged to projection and execution", async () => {
  const selection = Object.freeze({ action: "run" });
  const calls = [];
  function select(input) { calls.push(["select", input]); return selection; }
  function project(selected, input) { calls.push(["project", selected, input]); return "display"; }
  async function execute(selected, input) { calls.push(["execute", selected, input]); return "done"; }
  const contract = new StepExecutionContract({ select, project, execute });
  const input = Object.freeze({ state: "current" });
  const selected = contract.select(input);
  assert.equal(contract.project(selected, input), "display");
  assert.equal(await contract.execute(selected, input), "done");
  assert.deepEqual(calls, [["select", input], ["project", selection, input], ["execute", selection, input]]);
});

test("execution contract rejects anonymous adapters", () => {
  function project() {}
  function execute() {}
  const anonymous = (0, () => {});
  assert.throws(() => new StepExecutionContract({ select: anonymous, project, execute }), /named select/);
});
