import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { executeFiles } from "../run.js";
import { TestSuiteExecutionPolicy } from "../runner/suite-execution-policy.js";
import { ChildProcessExecutionRecordCodec } from "../../src/flow/lib/test-regression.js";

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

test("runner streams stdout and stderr before close and preserves split UTF-8 in one terminal capture", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  const execution = executeFiles(["tests/unit/example.test.js"], {
    spawnProcess: () => child, write: (fd, text) => writes.push([fd, text]), root: "/repo", jobs: 1,
  });
  child.stdout.emit("data", Buffer.from("# pass 3\n"));
  const japanese = Buffer.from("工程\n");
  child.stdout.emit("data", japanese.subarray(0, 1));
  child.stderr.emit("data", Buffer.from("provider diagnostic\n"));
  assert.deepEqual(writes, [[1, "# pass 3\n"], [2, "provider diagnostic\n"]]);
  child.stdout.emit("data", japanese.subarray(1));
  assert.deepEqual(writes.at(-1), [1, "工程\n"]);
  child.emit("close", 0, null);
  assert.equal(await execution, 0);
  const stdout = writes.filter(([fd]) => fd === 1).map(([, text]) => text).join("");
  const stderr = writes.filter(([fd]) => fd === 2).map(([, text]) => text).join("");
  assert.equal(stdout.split("# pass 3\n").length - 1, 1);
  assert.equal(stdout.split("工程\n").length - 1, 1);
  assert.match(stdout, /unit: 3/);
  const records = new ChildProcessExecutionRecordCodec().decodeAll(stderr);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "passed");
  assert.equal(records[0].stdout.content, "# pass 3\n工程\n");
  assert.equal(records[0].stderr.content, "provider diagnostic\n");
});

test("runner waits for close after a spawn error and records remaining output once without completed counts", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  const execution = executeFiles(["tests/unit/example.test.js"], {
    spawnProcess: () => child, write: (fd, text) => writes.push([fd, text]), root: "/repo", jobs: 1,
  });
  const failure = new Error("node could not start");
  failure.code = "ENOENT";
  child.emit("error", failure);
  await Promise.resolve();
  assert.deepEqual(writes, [], "a terminal record needs the close event, including trailing stream output");
  child.stderr.emit("data", Buffer.from("launch diagnostic\n"));
  assert.deepEqual(writes, [[2, "launch diagnostic\n"]]);
  child.emit("close", null, null);
  assert.equal(await execution, 1);
  const stderr = writes.filter(([fd]) => fd === 2).map(([, text]) => text).join("");
  const records = new ChildProcessExecutionRecordCodec().decodeAll(stderr);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "spawn-error");
  assert.equal(records[0].errorCode, "ENOENT");
  assert.equal(records[0].completed, false);
  assert.equal(records[0].stderr.content, "launch diagnostic\n");
  assert.match(writes.filter(([fd]) => fd === 1).map(([, text]) => text).join(""), /unit: not completed/);
});

test("runner child execution strips inherited Node test context and preserves temporary ownership", async () => {
  let childEnvironment;
  const inherited = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const spawnProcess = (_command, _args, options) => {
      childEnvironment = options.env;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit("data", "# pass 1\n"); child.emit("close", 0, null); });
      return child;
    };
    assert.equal(await executeFiles(["tests/unit/a.test.js"], { spawnProcess, write: () => {}, root: "/repo" }), 0);
    assert.equal(childEnvironment.NODE_TEST_CONTEXT, undefined);
    assert.equal(childEnvironment.TMPDIR, process.env.TMPDIR);
    assert.equal(childEnvironment.SENNEL_TEST_TEMP_ROOT, process.env.SENNEL_TEST_TEMP_ROOT);
    assert.equal(process.env.NODE_TEST_CONTEXT, "child-v8");
  } finally {
    if (inherited === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = inherited;
  }
});
