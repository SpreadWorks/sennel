import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { AbortHistoryRecord, AbortHistoryStore } from "../../../src/flow/lib/abort-history.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function record(overrides = {}) {
  return new AbortHistoryRecord({
    schemaVersion: 1,
    event: "abort-requested",
    operationId: "11111111-1111-4111-8111-111111111111",
    runId: "run-1",
    specId: "spec-1",
    recordedAt: "2026-10-14T00:00:00.000Z",
    reason: "中断\nrequested",
    stoppedStep: "spec-review",
    ...overrides,
  });
}

function fixture(t) {
  const directory = createTmpDir("abort-history-");
  t.after(() => removeTmpDir(directory));
  return new AbortHistoryStore({ directory });
}

describe("AbortHistoryStore", () => {
  it("persists requested and completed observations and reads typed records after reload", (t) => {
    const store = fixture(t);
    assert.deepEqual(store.read(), []);
    assert.equal(fs.existsSync(store.file), false);
    const requested = record();
    const completed = record({ event: "abort-completed", recordedAt: "2026-10-14T00:01:00.000Z", reason: null });
    assert.equal(store.append(requested), true);
    assert.equal(store.append(completed), true);
    const loaded = new AbortHistoryStore({ directory: path.dirname(store.file) }).read();
    assert.equal(loaded.length, 2);
    assert.ok(loaded.every((entry) => entry instanceof AbortHistoryRecord));
    assert.deepEqual(loaded.map((entry) => entry.toJSON()), [requested.toJSON(), completed.toJSON()]);
    assert.equal(fs.readFileSync(store.file).at(-1), 10);
  });

  it("preserves existing line bytes and accepts exact replay despite JSON key order", (t) => {
    const store = fixture(t);
    const requested = record();
    const reordered = Object.fromEntries(Object.entries(requested.toJSON()).reverse());
    const prefix = Buffer.from(`{${Object.entries(reordered)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}}\n`);
    fs.writeFileSync(store.file, prefix);
    assert.equal(store.append(requested), false);
    assert.deepEqual(fs.readFileSync(store.file), prefix);
    assert.equal(store.append(record({ event: "abort-completed" })), true);
    assert.deepEqual(fs.readFileSync(store.file).subarray(0, prefix.length), prefix);
  });

  it("rejects conflicting replay without changing history", (t) => {
    const store = fixture(t);
    store.append(record());
    const before = fs.readFileSync(store.file);
    assert.throws(() => store.append(record({ stoppedStep: "spec-gate" })), /conflicts/);
    assert.deepEqual(fs.readFileSync(store.file), before);
  });

  it("rejects incomplete, malformed and invalid-schema prefixes without appending", (t) => {
    const store = fixture(t);
    const valid = `${JSON.stringify(record())}\n`;
    const invalidSchema = { ...record().toJSON(), schemaVersion: 2 };
    for (const prefix of [
      valid.slice(0, -1), `${valid}{\n`, `${valid}\n`, `${JSON.stringify(invalidSchema)}\n`,
      Buffer.from([0xff, 10]),
      `${valid}${JSON.stringify(record({ reason: "changed" }))}\n`,
    ]) {
      const bytes = Buffer.from(prefix);
      fs.writeFileSync(store.file, bytes);
      assert.throws(() => store.read());
      assert.throws(() => store.append(record({ event: "abort-completed" })));
      assert.deepEqual(fs.readFileSync(store.file), bytes);
    }
  });

  it("validates observation identity and timestamps at the record boundary", () => {
    for (const overrides of [
      { schemaVersion: 2 }, { event: "aborted" }, { operationId: "not-a-uuid" },
      { runId: "" }, { specId: null }, { recordedAt: "invalid" }, { reason: undefined },
    ]) {
      assert.throws(() => record(overrides), TypeError);
    }
  });
});
