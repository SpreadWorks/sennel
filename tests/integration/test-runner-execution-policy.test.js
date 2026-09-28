import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { executeFiles } from "../run.js";
import { TestSuiteExecutionPolicy } from "../runner/suite-execution-policy.js";

test("execution policy supplies explicit suite defaults and accepts only overrides 1 or 2", () => {
  const policy = new TestSuiteExecutionPolicy();
  assert.equal(policy.concurrencyFor("unit"), 4);
  assert.equal(policy.concurrencyFor("integration"), 2);
  assert.equal(policy.concurrencyFor("e2e"), 2);
  assert.equal(policy.concurrencyFor("acceptance"), 1);
  assert.equal(policy.concurrencyFor("structure"), 1);
  assert.equal(new TestSuiteExecutionPolicy({ jobs: 2 }).concurrencyFor("unit"), 2);
  assert.throws(() => new TestSuiteExecutionPolicy({ jobs: 3 }), /1 or 2/);
});

test("runner passes policy default and explicit override to Node file concurrency", async () => {
  const commands = [];
  const spawnProcess = (command, args) => {
    commands.push([command, ...args]);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit("data", "# pass 1\n"); child.emit("close", 0, null); });
    return child;
  };
  await executeFiles(["tests/unit/a.test.js", "tests/e2e/b.test.js", "tests/structure/draft.test.js"], { spawnProcess, write: () => {}, root: "/repo" });
  assert.deepEqual(commands.map((value) => value.slice(0, 4)), [["node", "--test", "--test-concurrency", "4"], ["node", "--test", "--test-concurrency", "2"], ["node", "--test", "--test-concurrency", "1"]]);
  commands.length = 0;
  await executeFiles(["tests/unit/a.test.js"], { spawnProcess, write: () => {}, root: "/repo", jobs: 1 });
  assert.deepEqual(commands[0].slice(0, 4), ["node", "--test", "--test-concurrency", "1"]);
  commands.length = 0;
  await executeFiles([".tmp/a.test.js"], { spawnProcess, write: () => {}, root: "/repo", jobs: 2 });
  assert.deepEqual(commands[0].slice(0, 4), ["node", "--test", "--test-concurrency", "2"]);
});
