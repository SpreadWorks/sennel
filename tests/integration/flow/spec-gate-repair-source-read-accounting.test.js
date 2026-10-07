import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowArtifactCatalogSnapshotLimits } from "../../../src/lib/flow-version.js";
import { readSpecGateRepairSources, SpecGateRepairSourceCaptureBudget } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { captureRegularFile } from "../../../src/lib/regular-file-snapshot.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function ruleFixture(t) {
  const root = createTmpDir("repair-rule-read-accounting-");
  t.after(() => removeTmpDir(root));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "r".repeat(8192));
  fs.writeFileSync(path.join(root, "src/AGENTS.md"), "s".repeat(12000));
  assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
  assert.equal(runGit(["add", "AGENTS.md", "src"], { cwd: root }).ok, true);
  return root;
}

function observeFileReads(root, operation, { beforeRead = null } = {}) {
  const open = fs.openSync;
  const read = fs.readFileSync;
  const close = fs.closeSync;
  const files = new Map();
  const events = [];
  fs.openSync = function (file, ...args) {
    const descriptor = open.call(this, file, ...args);
    if (typeof file === "string" && path.relative(root, file) !== ".." && !path.relative(root, file).startsWith(`..${path.sep}`)) {
      files.set(descriptor, file);
    }
    return descriptor;
  };
  fs.readFileSync = function (descriptor, ...args) {
    const file = files.get(descriptor);
    if (file !== undefined) beforeRead?.(file);
    const bytes = read.call(this, descriptor, ...args);
    if (file !== undefined) {
      events.push({ origin: path.relative(root, file), byteLength: bytes.length });
      operation(file, bytes);
    }
    return bytes;
  };
  fs.closeSync = function (descriptor) {
    files.delete(descriptor);
    return close.call(this, descriptor);
  };
  return { events, restore() { fs.openSync = open; fs.readFileSync = read; fs.closeSync = close; } };
}

for (const unmeasurable of [false, true]) {
  test(`${unmeasurable ? "unmeasurable read failure reserves its full bound" : "post-read identity refusal accounts its exact bytes"} before admitting another rule capture`, (t) => {
    const root = ruleFixture(t);
    const cap = 16384;
    const captureBudget = new SpecGateRepairSourceCaptureBudget({
      limits: new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: cap, maxTotalArtifactBytes: cap }),
      maxReadBytes: cap,
    });
    const reader = observeFileReads(root, (file) => {
      if (file !== path.join(root, "AGENTS.md")) return;
      if (unmeasurable) throw Object.assign(new Error("injected read failure after consuming bytes"), { code: "EIO" });
      fs.appendFileSync(file, "x");
    });
    let sources;
    try {
      sources = readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
        state: { request: "Read src/AGENTS.md.", issue: null }, executionRoot: root, spec: {}, captureBudget });
    } finally { reader.restore(); }
    t.diagnostic(JSON.stringify({ cap, physicalReadBytes: reader.events.reduce((total, event) => total + event.byteLength, 0),
      accountedReadBytes: captureBudget.readBytes, remainingReadBytes: captureBudget.remainingReadBytes,
      events: reader.events }));
    assert.deepEqual(reader.events, [{ origin: "AGENTS.md", byteLength: 8192 }], "the second rule body must remain unread");
    assert.equal(captureBudget.readBytes, unmeasurable ? cap : 8192);
    assert.equal(captureBudget.remainingReadBytes, unmeasurable ? 0 : cap - 8192);
    assert.equal(captureBudget.serializedBytes, 0, "physical reads do not consume serialization allowance");
    const rules = new Map(sources.map((source) => [source.origin, source]));
    for (const origin of ["AGENTS.md", "src/AGENTS.md"]) {
      assert.equal(rules.get(origin).availability, "unavailable");
      assert.equal(rules.get(origin).content, "");
      assert.equal(rules.get(origin).byteLength, 0);
      assert.throws(() => rules.get(origin).assertAvailable(), { code: "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" });
    }
    assert.equal(fs.statSync(path.join(root, "AGENTS.md")).size, unmeasurable ? 8192 : 8193);
    assert.equal(fs.statSync(path.join(root, "src/AGENTS.md")).size, 12000);
  });
}

test("the shared capture boundary reports successful exact UTF-8 bytes and no consumption for a pre-read size refusal", (t) => {
  const root = createTmpDir("regular-file-read-accounting-");
  t.after(() => removeTmpDir(root));
  const file = path.join(root, "rules.md");
  const bytes = Buffer.from("\ufeffRoot 漢🧭 rule\r\n");
  fs.writeFileSync(file, bytes);
  const consumption = [];
  const snapshot = captureRegularFile(file, { label: "rule fixture", maxBytes: bytes.length,
    onRead: (byteLength) => consumption.push(byteLength) });
  assert.deepEqual(snapshot.bytes, bytes);
  assert.deepEqual(consumption, [bytes.length]);
  assert.throws(() => captureRegularFile(file, { label: "rule fixture", maxBytes: bytes.length - 1,
    onRead: (byteLength) => consumption.push(byteLength) }), /regular real file/);
  assert.deepEqual(consumption, [bytes.length], "admission refusal happens before any physical body read");
});


test("a measured physical overflow remains accounted and stops capture without charging a callback failure twice", (t) => {
  const root = ruleFixture(t);
  const cap = 8192;
  const captureBudget = new SpecGateRepairSourceCaptureBudget({
    limits: new FlowArtifactCatalogSnapshotLimits({ maxArtifactBytes: cap, maxTotalArtifactBytes: cap }), maxReadBytes: cap,
  });
  const reader = observeFileReads(root, () => {}, { beforeRead: (file) => {
    if (file === path.join(root, "AGENTS.md")) fs.appendFileSync(file, "x");
  } });
  try {
    assert.throws(() => readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
      state: { request: "Read src/AGENTS.md.", issue: null }, executionRoot: root, spec: {}, captureBudget }),
    /remaining capture budget/);
  } finally { reader.restore(); }
  assert.deepEqual(reader.events, [{ origin: "AGENTS.md", byteLength: cap + 1 }]);
  assert.equal(captureBudget.readBytes, cap + 1);
  assert.equal(captureBudget.remainingReadBytes, 0);
  assert.equal(captureBudget.nextReadLimit, 0);
  assert.equal(captureBudget.serializedBytes, 0);
});
