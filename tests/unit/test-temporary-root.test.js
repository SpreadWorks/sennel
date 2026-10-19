import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import path from "node:path";
import { TestTemporaryRoot } from "../test-temporary-root.js";

const ROOT = path.resolve(".tmp", "unit-selected");

test("an allocated test root propagates storage failure without trying another root", async () => {
  const failure = Object.assign(new Error("selected storage is full"), { code: "ENOSPC" });
  const removals = [];
  const root = new TestTemporaryRoot(ROOT, { remove: (directory) => removals.push(directory) });
  const environment = { TMPDIR: "previous" };
  let writes = 0;
  await assert.rejects(root.use(() => {
    writes += 1;
    assert.equal(environment.TMPDIR, root.path);
    assert.equal(environment.TMP, root.path);
    assert.equal(environment.TEMP, root.path);
    throw failure;
  }, { environment, processEvents: new EventEmitter() }), (error) => error === failure);
  assert.equal(writes, 1);
  assert.equal(root.path, ROOT);
  assert.deepEqual(removals, [root.path]);
  assert.deepEqual(environment, { TMPDIR: "previous" });
});

test("borrowed test temporary roots never remove the owner's files", async () => {
  const removals = [];
  const root = new TestTemporaryRoot(ROOT, {
    owned: false,
    remove: (...args) => removals.push(args),
  });
  const environment = { TMPDIR: "previous", SENNEL_TEST_TEMP_ROOT: "shared", GIT_CEILING_DIRECTORIES: "ceiling" };
  await root.use(() => {
    assert.equal(environment.SENNEL_TEST_TEMP_ROOT, root.path);
    assert.equal(environment.GIT_CEILING_DIRECTORIES, `${path.dirname(ROOT)}${path.delimiter}ceiling`);
  }, { environment, processEvents: new EventEmitter() });
  root.remove();
  assert.deepEqual(removals, []);
  assert.deepEqual(environment, { TMPDIR: "previous", SENNEL_TEST_TEMP_ROOT: "shared", GIT_CEILING_DIRECTORIES: "ceiling" });
});

test("test temporary root restores TMPDIR and removes its complete tree after success or failure", async () => {
  for (const shouldFail of [false, true]) {
    const removals = [];
    const environment = { TMPDIR: "/disk/tmp" };
    const processEvents = new EventEmitter();
    const root = new TestTemporaryRoot(ROOT, {
      remove: (...args) => removals.push(args),
    });

    const result = root.use(async () => {
      assert.equal(environment.TMPDIR, ROOT);
      if (shouldFail) throw new Error("test failure");
      return "passed";
    }, { environment, processEvents });

    if (shouldFail) await assert.rejects(result, /test failure/);
    else assert.equal(await result, "passed");
    assert.equal(environment.TMPDIR, "/disk/tmp");
    assert.deepEqual(removals, [[
      ROOT,
      { recursive: true, force: true },
    ]]);
    assert.equal(processEvents.listenerCount("exit"), 0);
    assert.equal(processEvents.listenerCount("SIGINT"), 0);
    assert.equal(processEvents.listenerCount("SIGTERM"), 0);
  }
});

test("test temporary root exit cleanup is idempotent", async () => {
  const removals = [];
  const environment = {};
  const processEvents = new EventEmitter();
  const root = new TestTemporaryRoot(ROOT, {
    remove: (...args) => removals.push(args),
  });

  await root.use(async () => {
    processEvents.emit("exit");
  }, { environment, processEvents });

  assert.equal("TMPDIR" in environment, false);
  assert.equal(removals.length, 1);
});

test("test temporary root removes itself before preserving an interrupt signal", async () => {
  const events = [];
  const processEvents = new EventEmitter();
  const root = new TestTemporaryRoot(ROOT, {
    remove: () => events.push("removed"),
  });

  await root.use(async () => {
    processEvents.emit("SIGINT");
  }, {
    environment: {},
    processEvents,
    terminate: (signal) => events.push(signal),
  });

  assert.deepEqual(events, ["removed", "SIGINT"]);
  assert.equal(processEvents.listenerCount("SIGINT"), 0);
});
