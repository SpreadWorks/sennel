import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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
  let file;
  try {
    const options = delivery.options();
    assert.equal(options.stdio.length, 3);
    const configuration = JSON.parse(Buffer.from(options.env.NODE_OPTIONS.split("#").at(-1), "base64url"));
    file = configuration.file;
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(payload.identity, currentRuntimePackage().toJSON());
    assert.equal(payload.resources.some(([name]) => name === "src/lib/runtime-child-bootstrap.js"), true);
    const entries = fs.readdirSync(selected);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^child-/);
    assert.deepEqual(fs.readdirSync(path.join(selected, entries[0])), ["delivery.json"]);
    const child = spawnSync(process.execPath, ["-e", ""], options);
    assert.equal(child.status, 0, child.stderr.toString());
  } finally { delivery.close(); }
  assert.equal(fs.existsSync(file), false);
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


test("delivery cleanup preserves changed payload bytes and invalid acknowledgements until corrected by the owner", (t) => {
  const { root } = fixture(t);
  const delivery = new RuntimeChildExecution({ root });
  const configuration = JSON.parse(Buffer.from(delivery.environment.NODE_OPTIONS.split("#").at(-1), "base64url"));
  const original = fs.readFileSync(configuration.file);
  const changed = Buffer.from(original);
  changed[0] = changed[0] === 65 ? 66 : 65;
  fs.writeFileSync(configuration.file, changed);
  assert.throws(() => delivery.close(), /cleanup refused changed delivery bytes/);
  assert.deepEqual(fs.readFileSync(configuration.file), changed);
  fs.writeFileSync(configuration.file, original);
  const acknowledgement = path.join(path.dirname(configuration.file), "acknowledgement.json");
  fs.writeFileSync(acknowledgement, JSON.stringify({ revision: configuration.revision, digest: "0".repeat(64) }));
  assert.throws(() => delivery.consumeAcknowledgement(), /RUNTIME_DELIVERY_ACKNOWLEDGEMENT_INVALID/);
  assert.throws(() => delivery.close(), /RUNTIME_DELIVERY_ACKNOWLEDGEMENT_INVALID/);
  assert.equal(fs.existsSync(configuration.file), true);
  fs.writeFileSync(acknowledgement, JSON.stringify({ revision: configuration.revision, digest: configuration.digest }));
  assert.equal(delivery.consumeAcknowledgement(), true);
  assert.equal(fs.existsSync(configuration.file), false);
});

test("acknowledgement cleanup refuses a replaced owned directory without adopting a foreign child", (t) => {
  const { root } = fixture(t);
  const delivery = new RuntimeChildExecution({ root });
  const configuration = JSON.parse(Buffer.from(delivery.environment.NODE_OPTIONS.split("#").at(-1), "base64url"));
  const owned = path.dirname(configuration.file);
  const retained = `${owned}-retained`;
  fs.renameSync(owned, retained);
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, "sentinel"), "foreign owner");
  assert.throws(() => delivery.consumeAcknowledgement(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.throws(() => delivery.close(), /directory identity changed/);
  assert.equal(fs.readFileSync(path.join(owned, "sentinel"), "utf8"), "foreign owner");
  assert.equal(fs.existsSync(path.join(retained, "delivery.json")), true);
});
