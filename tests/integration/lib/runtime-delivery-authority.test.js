import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RuntimeChildExecution, currentRuntimePackage } from "../../../src/lib/runtime-package.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function fixture(t) {
  const root = createTmpDir("runtime-delivery-authority-");
  t.after(() => removeTmpDir(root));
  return { root, selected: new TemporaryPaths(root).runtime("delivery-authority") };
}

test("runtime delivery uses its selected temporary parent and releases its owned child", (t) => {
  const { root, selected } = fixture(t);
  const delivery = new RuntimeChildExecution({ root, temporaryRoot: selected });
  let descriptor;
  try {
    const options = delivery.options();
    descriptor = options.stdio[3];
    const payload = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    assert.deepEqual(payload.identity, currentRuntimePackage().toJSON());
    assert.equal(payload.resources.some(([name]) => name === "src/lib/runtime-child-bootstrap.js"), true);
    const entries = fs.readdirSync(selected);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^child-/);
    assert.deepEqual(fs.readdirSync(path.join(selected, entries[0])), ["delivery.json"]);
  } finally { delivery.close(); }
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  assert.throws(() => delivery.options(), /delivery is closed/i);
  assert.deepEqual(fs.readdirSync(selected), []);
});

test("runtime delivery refuses a replaced ensured parent before allocating or writing foreign content", (t) => {
  const { root, selected } = fixture(t);
  const retained = `${selected}-retained`;
  const ensure = TemporaryPaths.prototype.ensureDirectory;
  const mkdtemp = fs.mkdtempSync;
  let replaced = false;
  let childAllocations = 0;
  let delivery;
  TemporaryPaths.prototype.ensureDirectory = function (directory) {
    const result = ensure.call(this, directory);
    if (result === selected && !replaced) {
      replaced = true;
      fs.renameSync(selected, retained);
      fs.mkdirSync(selected);
      fs.writeFileSync(path.join(selected, "sentinel"), "foreign owner bytes");
    }
    return result;
  };
  fs.mkdtempSync = (prefix, ...args) => {
    if (String(prefix).startsWith(path.join(selected, "child-"))) childAllocations++;
    return mkdtemp(prefix, ...args);
  };
  try {
    assert.throws(() => { delivery = new RuntimeChildExecution({ root, temporaryRoot: selected }); },
      (error) => error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
  } finally {
    TemporaryPaths.prototype.ensureDirectory = ensure;
    fs.mkdtempSync = mkdtemp;
    delivery?.close();
  }
  assert.equal(replaced, true);
  assert.equal(childAllocations, 0);
  assert.deepEqual(fs.readdirSync(selected), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(selected, "sentinel"), "utf8"), "foreign owner bytes");
  assert.deepEqual(fs.readdirSync(retained), []);
});
