import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessExecutionValueEncoding } from "../../src/lib/process-execution-values.js";

test("decoded JSON comparison retains the complete captured value independently of object-key order", () => {
  const original = { version: 9, requests: [{ value: "日本語 😀", empty: null }], events: [] };
  const captured = new ProcessExecutionValueEncoding(original);
  const text = captured.text(), digest = captured.digest;
  original.requests[0].value = "producer changed";
  const decoded = { events: [], requests: [{ empty: null, value: "日本語 😀" }], version: 9 };
  assert.equal(captured.matchesJSON(decoded), true);
  decoded.requests[0].value = "consumer changed";
  assert.equal(captured.matchesJSON(decoded), false);
  assert.equal(captured.matchesJSON(JSON.parse(text)), true);
  assert.equal(captured.text(), text);
  assert.equal(captured.digest, digest);
  assert.equal(captured.hasSameValue(new ProcessExecutionValueEncoding(JSON.parse(text))), true);
});

test("decoded comparisons reject missing, unknown, sparse, reordered and non-JSON values without normalization", () => {
  const captured = new ProcessExecutionValueEncoding({ first: [null, 1], last: null });
  for (const value of [
    { first: [null, 1] },
    { first: [null, 1], last: null, extra: true },
    { first: [null, 1], last: null, extra: undefined },
    { first: Array(2), last: null },
    { first: [1, null], last: null },
    { first: [undefined, 1], last: null },
    { first: [NaN, 1], last: null },
  ]) assert.equal(captured.matchesJSON(value), false);
  assert.equal(captured.matchesJSON({ last: null, first: [null, 1] }), true);
});

test("decoded comparisons do not call a foreign serializer to manufacture matching JSON", () => {
  const captured = new ProcessExecutionValueEncoding({ value: 1 });
  let called = false;
  const foreign = { toJSON() { called = true; return { value: 1 }; } };
  assert.equal(captured.matchesJSON(foreign), false);
  assert.equal(called, false);
  assert.equal(captured.hasSameValue(new ProcessExecutionValueEncoding(foreign)), true);
  assert.equal(called, true);
});

test("encoded semantic equality still distinguishes values while permitting changed key order on repeated comparisons", () => {
  const first = new ProcessExecutionValueEncoding({ a: { b: "retained", c: null }, d: [1, 2] });
  const reordered = new ProcessExecutionValueEncoding({ d: [1, 2], a: { c: null, b: "retained" } });
  const changed = new ProcessExecutionValueEncoding({ d: [2, 1], a: { c: null, b: "retained" } });
  assert.equal(first.matches(reordered), false);
  for (let index = 0; index < 3; index++) {
    assert.equal(first.hasSameValue(reordered), true);
    assert.equal(first.hasSameValue(changed), false);
  }
  assert.equal(first.hasSameValue({}), false);
});

test("composed encodings preserve complete nested JSON bytes and digests without calling a captured producer again", () => {
  let serializations = 0, value = "日本語 😀";
  const producer = { toJSON() { serializations++; return { value, empty: null }; } };
  const child = new ProcessExecutionValueEncoding(producer);
  const captured = ProcessExecutionValueEncoding.object([
    ["items", ProcessExecutionValueEncoding.array([child, new ProcessExecutionValueEncoding(null)])],
    ["enabled", new ProcessExecutionValueEncoding(false)],
  ]);
  const expected = { items: [{ value, empty: null }, null], enabled: false };
  const original = new ProcessExecutionValueEncoding(expected);
  assert.equal(captured.text(), original.text());
  assert.equal(captured.digest, original.digest);
  assert.equal(captured.matchesJSON(expected), true);
  value = "changed producer";
  assert.equal(ProcessExecutionValueEncoding.array([child]).text(), JSON.stringify([expected.items[0]]));
  assert.equal(serializations, 1);
  assert.equal(child.matches(new ProcessExecutionValueEncoding(producer)), false);
  assert.equal(serializations, 2);
});

test("composed objects retain JSON numeric-key order and prototype-named keys as ordinary data", () => {
  const entries = [["10", "ten"], ["2", "two"], ["01", "first"], ["__proto__", { safe: true }],
    ["constructor", null], ["toJSON", "data"], ["quoted\"\n", "\u0000\ud800😀"]];
  const expected = Object.fromEntries(entries);
  const captured = ProcessExecutionValueEncoding.object(entries.map(([name, value]) => [name, new ProcessExecutionValueEncoding(value)]));
  assert.equal(captured.text(), JSON.stringify(expected));
  assert.equal(captured.digest, new ProcessExecutionValueEncoding(expected).digest);
  assert.deepEqual(JSON.parse(captured.text()), expected);
  assert.equal(ProcessExecutionValueEncoding.object([]).text(), "{}");
  assert.equal(ProcessExecutionValueEncoding.array([]).text(), "[]");
});

test("compositions refuse holes, unknown values and invalid or duplicate object fields", () => {
  const value = new ProcessExecutionValueEncoding(1);
  const forged = Object.create(ProcessExecutionValueEncoding.prototype), proxied = new Proxy(value, {});
  for (const input of [null, {}, [1], [{}], Array(1), [forged], [proxied]]) {
    assert.throws(() => ProcessExecutionValueEncoding.array(input), TypeError);
  }
  for (const input of [null, {}, Array(1), [["name"]], [["name", value, value]],
    [[1, value]], [["name", {}]], [["name", forged]], [["name", proxied]], [["name", value], ["name", value]]]) {
    assert.throws(() => ProcessExecutionValueEncoding.object(input), TypeError);
  }
});

test("composed values remain immutable snapshots when their input containers and source values change", () => {
  const source = { items: [1, 2] };
  const child = new ProcessExecutionValueEncoding(source);
  const values = [child], entries = [["before", child]];
  const array = ProcessExecutionValueEncoding.array(values), object = ProcessExecutionValueEncoding.object(entries);
  source.items.reverse(); values[0] = new ProcessExecutionValueEncoding(source); entries[0][0] = "after";
  assert.equal(array.text(), '[{"items":[1,2]}]');
  assert.equal(object.text(), '{"before":{"items":[1,2]}}');
  assert.equal(Object.isFrozen(array), true); assert.equal(Object.isFrozen(object), true);
  assert.equal(new ProcessExecutionValueEncoding("raw", Symbol("composed execution value encoding")).text(), '"raw"');
});
