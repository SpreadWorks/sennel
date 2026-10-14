import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RuntimeChildExecution, currentRuntimePackage, readRuntimeResource } from "../../../src/lib/runtime-package.js";
import { runCmd } from "../../../src/lib/process.js";

test("successive runtime children preserve parent resources, target environment and stdin and close each delivery", (t) => {
  const root = createTestDirectory("runtime-child-execution-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.mjs");
  const runtimeUrl = new URL("../../../src/lib/runtime-package.js", import.meta.url).href;
  const resource = new URL("../../../src/presets/base/preset.json", import.meta.url).href;
  fs.writeFileSync(probe, `
    import fs from 'node:fs';
    import { currentRuntimePackage, readRuntimeResource } from ${JSON.stringify(runtimeUrl)};
    console.log(JSON.stringify({ revision: currentRuntimePackage().revision,
      resource: readRuntimeResource(new URL(${JSON.stringify(resource)})),
      cwd: process.cwd(), target: process.env.RUNTIME_CHILD_TARGET,
      nodeOptions: process.env.NODE_OPTIONS, stdin: fs.readFileSync(0, 'utf8') }));
  `);
  const environment = { ...process.env, NODE_OPTIONS: "--no-warnings", RUNTIME_CHILD_TARGET: "live-project" };
  const originalOptions = process.env.NODE_OPTIONS;
  for (let index = 0; index < 2; index++) {
    let descriptor;
    const result = RuntimeChildExecution.runSync(probe, [], { cwd: root, env: environment }, (command, args, options) => {
      descriptor = options.stdio[3];
      return runCmd(command, args, options);
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { revision: currentRuntimePackage().revision,
      resource: readRuntimeResource(new URL(resource)), cwd: root, target: "live-project",
      nodeOptions: "--no-warnings", stdin: "" });
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  }
  assert.equal(environment.NODE_OPTIONS, "--no-warnings");
  assert.equal(process.env.NODE_OPTIONS, originalOptions);
});

test("runtime delivery closes on runner throws and process launch failure", () => {
  const failure = new Error("runner failed");
  let descriptor;
  assert.throws(() => RuntimeChildExecution.runSync("unused.mjs", [], {}, (_command, _args, options) => {
    descriptor = options.stdio[3];
    throw failure;
  }), (error) => error === failure);
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  const result = RuntimeChildExecution.runSync("unused.mjs", [], {}, (_command, args, options) => {
    descriptor = options.stdio[3];
    return runCmd("sennel-test-missing-executable", args, options);
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "ENOENT");
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
});
