import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("native inherited coverage launches preserve captured environment evidence and isolated options", t => {
  const root = createTmpDir("native-command-environment-");
  t.after(() => removeTmpDir(root));
  const coverage = path.join(root, "coverage");
  const original = { LITERAL: "$unchanged;日本語" };
  const invocation = new NativeExecutableInvocation({ executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({literal:process.env.LITERAL,coverage:process.env.NODE_V8_COVERAGE}))"],
    cwd: root, env: original });
  const captured = invocation.toJSON();
  assert.equal(Object.isFrozen(invocation.env), true);
  const inherited = process.env.NODE_V8_COVERAGE;
  try {
    process.env.NODE_V8_COVERAGE = coverage;
    const firstOptions = invocation.processOptions();
    const first = spawnSync(invocation.executable, invocation.args, { ...firstOptions, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.signal, null);
    assert.deepEqual(JSON.parse(first.stdout), { literal: original.LITERAL, coverage });
    assert.deepEqual(invocation.toJSON(), captured, "Node's inherited-variable propagation cannot change durable invocation evidence");
    assert.deepEqual(original, { LITERAL: "$unchanged;日本語" });

    const secondOptions = invocation.processOptions();
    secondOptions.env.LITERAL = "second native launch";
    const second = spawnSync(invocation.executable, invocation.args, { ...secondOptions, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.signal, null);
    assert.deepEqual(JSON.parse(second.stdout), { literal: "second native launch", coverage });
    assert.equal(firstOptions.env.LITERAL, original.LITERAL);
    assert.equal(invocation.processOptions().env.LITERAL, original.LITERAL);
    assert.deepEqual(invocation.toJSON(), captured, "native option changes remain local to that launch");
    assert.deepEqual(original, { LITERAL: "$unchanged;日本語" });
  } finally {
    if (inherited === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = inherited;
  }
});
