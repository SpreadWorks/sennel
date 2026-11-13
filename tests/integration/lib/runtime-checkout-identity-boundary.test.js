import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { captureProcessExecutionCheckoutIdentity } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionCheckoutIdentity } from "../../../src/lib/process-execution-values.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

// Simulated native Stats exercise identity width/sign, not native OS acceptance.
function roots(t) {
  const root = createTmpDir("checkout-exact-identity-");
  t.after(() => removeTmpDir(root));
  const executionRoot = path.join(root, "execution");
  fs.mkdirSync(executionRoot);
  return { mainRoot: root, executionRoot };
}

test("checkout capture retains its ordinary physical roots across strict JSON readback", (t) => {
  const selection = roots(t);
  const captured = captureProcessExecutionCheckoutIdentity(selection);
  const restored = new ProcessExecutionCheckoutIdentity(JSON.parse(JSON.stringify(captured)));
  assert.equal(restored.matches(captured), true);
  assert.equal(restored.mainRoot, selection.mainRoot);
  assert.equal(restored.executionRoot, selection.executionRoot);
});

for (const field of ["dev", "ino"]) for (const initial of [9007199254740992n, -9223372036854775803n]) {
  test(`checkout ${field} capture preserves signed exact native identity ${initial} without adjacent aliasing`, (t) => {
    const selection = roots(t);
    const nativeLstat = fs.lstatSync;
    let observed = initial;
    t.mock.method(fs, "lstatSync", (target, options) => {
      const stat = nativeLstat(target, options);
      if (target === selection.mainRoot || target === selection.executionRoot) {
        stat[field] = options?.bigint === true ? observed : Number(observed);
      }
      return stat;
    });
    const captured = captureProcessExecutionCheckoutIdentity(selection);
    const key = field === "dev" ? "mainDevice" : "mainInode";
    const checkoutKey = field === "dev" ? "checkoutDevice" : "checkoutInode";
    assert.equal(BigInt(captured[key]), initial);
    assert.equal(BigInt(captured[checkoutKey]), initial);
    const restored = new ProcessExecutionCheckoutIdentity(JSON.parse(JSON.stringify(captured)));
    assert.equal(restored.matches(captured), true);
    observed += 1n;
    assert.equal(Number(observed), Number(initial));
    const changed = captureProcessExecutionCheckoutIdentity(selection);
    assert.equal(BigInt(changed[key]), observed);
    assert.equal(changed.matches(captured), false);
    assert.equal(changed.matchesRepository(restored), false);
  });
}
