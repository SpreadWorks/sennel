import assert from "node:assert/strict";
import { test } from "node:test";
import { executeFiles, executeFilesInTemporaryRoot } from "../run.js";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestTemporaryRoot } from "../test-temporary-root.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";
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
  const executeProcess = async (invocation, _args, options) => {
    commands.push([invocation.executable, ...invocation.args]);
    options.onStdoutBytes(Buffer.from("# pass 1\n"));
    return { code: 0, signal: null };
  };
  await executeFiles(["tests/unit/a.test.js", "tests/e2e/b.test.js", "tests/structure/draft.test.js"], { executeProcess, write: () => {}, root: "/repo" });
  assert.deepEqual(commands.map((value) => value.slice(0, 4)), [[process.execPath, "--test", "--test-concurrency", "4"], [process.execPath, "--test", "--test-concurrency", "2"], [process.execPath, "--test", "--test-concurrency", "1"]]);
  commands.length = 0;
  await executeFiles(["tests/unit/a.test.js"], { executeProcess, write: () => {}, root: "/repo", jobs: 1 });
  assert.deepEqual(commands[0].slice(0, 4), [process.execPath, "--test", "--test-concurrency", "1"]);
  commands.length = 0;
  await executeFiles([".tmp/a.test.js"], { executeProcess, write: () => {}, root: "/repo", jobs: 2 });
  assert.deepEqual(commands[0].slice(0, 4), [process.execPath, "--test", "--test-concurrency", "2"]);
});

test("runner streams stdout and stderr before close and preserves split UTF-8 in one terminal capture", async () => {
  let callbacks;
  let settle;
  let refuse;
  const pending = new Promise((resolve, reject) => { settle = resolve; refuse = reject; });
  const writes = [];
  const execution = executeFiles(["tests/unit/example.test.js"], {
    executeProcess: (_invocation, _args, options) => { callbacks = options; return pending; }, write: (fd, text) => writes.push([fd, text]), root: "/repo", jobs: 1,
  });
  callbacks.onStdoutBytes(Buffer.from("# pass 3\n"));
  const japanese = Buffer.from("工程\n");
  callbacks.onStdoutBytes(japanese.subarray(0, 1));
  callbacks.onStderrBytes(Buffer.from("provider diagnostic\n"));
  assert.deepEqual(writes, [[1, "# pass 3\n"], [2, "provider diagnostic\n"]]);
  callbacks.onStdoutBytes(japanese.subarray(1));
  assert.deepEqual(writes.at(-1), [1, "工程\n"]);
  settle({ code: 0, signal: null });
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

test("runner waits for execution settlement after a spawn error and records remaining output once without completed counts", async () => {
  let callbacks;
  let settle;
  let refuse;
  const pending = new Promise((resolve, reject) => { settle = resolve; refuse = reject; });
  const writes = [];
  const execution = executeFiles(["tests/unit/example.test.js"], {
    executeProcess: (_invocation, _args, options) => { callbacks = options; return pending; }, write: (fd, text) => writes.push([fd, text]), root: "/repo", jobs: 1,
  });
  const failure = new Error("node could not start");
  failure.code = "ENOENT";
  // The executor owns child error/close ordering; settlement follows drained output.
  await Promise.resolve();
  assert.deepEqual(writes, [], "a terminal record needs execution settlement, including trailing stream output");
  callbacks.onStderrBytes(Buffer.from("launch diagnostic\n"));
  assert.deepEqual(writes, [[2, "launch diagnostic\n"]]);
  refuse(failure);
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
    const executeProcess = async (invocation, _args, options) => {
      childEnvironment = invocation.env;
      options.onStdoutBytes(Buffer.from("# pass 1\n"));
      return { code: 0, signal: null };
    };
    assert.equal(await executeFiles(["tests/unit/a.test.js"], { executeProcess, write: () => {}, root: "/repo" }), 0);
    assert.equal(childEnvironment.NODE_TEST_CONTEXT, undefined);
    assert.equal(childEnvironment.TMPDIR, process.env.TMPDIR);
    assert.equal(childEnvironment.TMP, process.env.TMP);
    assert.equal(childEnvironment.TEMP, process.env.TEMP);
    assert.equal(childEnvironment.SENNEL_TEST_TEMP_ROOT, process.env.SENNEL_TEST_TEMP_ROOT);
    assert.equal(process.env.NODE_TEST_CONTEXT, "child-v8");
  } finally {
    if (inherited === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = inherited;
  }
});


test("runner retains shared fixture storage when execution completion is unknown", async () => {
  const temporaryRoot = TestTemporaryRoot.createOnRepository();
  const failure = new ProcessExecutionControlFailure("endpoint-unavailable", "Coordinator response unavailable");
  const writes = [];
  try {
    await assert.rejects(executeFilesInTemporaryRoot(["tests/unit/a.test.js"], {
      temporaryRoot, executeProcess: async () => { throw failure; }, write: (_fd, text) => writes.push(text),
    }), (error) => error === failure);
    assert.equal(temporaryRoot.retained, true);
    assert.equal(existsSync(temporaryRoot.path), true);
    assert.match(writes.join(""), /retained test temporary storage/);
    assert.doesNotMatch(writes.join(""), /removed after run/);
  } finally {
    // This executor was a deterministic fake; there is no live child to retain.
    rmSync(temporaryRoot.path, { recursive: true, force: true });
  }
});

test("runner removes owned fixture storage after confirmed child completion", async () => {
  const temporaryRoot = TestTemporaryRoot.createOnRepository();
  assert.equal(await executeFilesInTemporaryRoot(["tests/unit/a.test.js"], {
    temporaryRoot, executeProcess: async () => ({ code: 0, signal: null }), write: () => {},
  }), 0);
  assert.equal(existsSync(temporaryRoot.path), false);
});

test("borrowed fixture retention prevents the owning runner from removing unknown execution evidence", () => {
  const owner = TestTemporaryRoot.createOnRepository();
  try {
    const borrower = new TestTemporaryRoot(owner.path, { owned: false });
    borrower.retainOnUnconfirmedExecution();
    owner.remove();
    assert.equal(owner.retained, true);
    assert.equal(existsSync(owner.path), true);
  } finally {
    rmSync(owner.path, { recursive: true, force: true });
  }
});


test("registered test host gives independent fixtures no inherited product grant", async () => {
  const temporaryRoot = TestTemporaryRoot.createOnRepository();
  const fixture = join(temporaryRoot.path, "independent-fixture.test.mjs");
  writeFileSync(fixture, `import test from 'node:test';import assert from 'node:assert/strict';test('independent fixture authority',()=>{assert.equal(process.env.SENNEL_PROCESS_EXECUTION_SCOPE,undefined);assert.equal(process.env.SENNEL_TEST_TEMP_ROOT,${JSON.stringify(temporaryRoot.path)});});`);
  const writes = [];
  const exitCode = await executeFilesInTemporaryRoot([fixture], { temporaryRoot, write: (_fd, text) => writes.push(text) });
  assert.equal(exitCode, 0, writes.join(""));
  assert.match(writes.join(""), /independent fixture authority/);
  assert.equal(existsSync(temporaryRoot.path), false);
});


test("exit cleanup retains temporary authority while a test execution has no completion proof", () => {
  const temporaryRoot = TestTemporaryRoot.createOnRepository();
  try {
    temporaryRoot.beginExecution();
    temporaryRoot.remove();
    assert.equal(temporaryRoot.retained, true);
    assert.equal(existsSync(temporaryRoot.path), true);
  } finally {
    // The pending execution is a lifecycle fixture; no child was started.
    rmSync(temporaryRoot.path, { recursive: true, force: true });
  }
});
