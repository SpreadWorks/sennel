import assert from "node:assert/strict";
import { it } from "node:test";
import { freezeExecutionValue } from "../../src/lib/process-execution-values.js";

it("freezes shared plain data and arrays even beneath an already frozen input", () => {
  const child = { values: [{ value: 1 }] };
  const root = Object.freeze({ first: child, second: child });
  assert.equal(freezeExecutionValue(root), root);
  freezeExecutionValue(root);
  for (const value of [root, child, child.values, child.values[0]]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { child.values[0].value = 2; }, TypeError);
});

it("expires reusable freeze proofs while preserving an old graph and its aliases", (t) => {
  const child = { value: 1 };
  const root = { first: child, second: child };
  freezeExecutionValue(root);
  freezeExecutionValue(Array.from({ length: 100_000 }, (_, value) => ({ value })));

  const values = t.mock.method(Object, "values");
  assert.equal(freezeExecutionValue(root), root);
  assert.equal(values.mock.calls.filter((call) => call.arguments[0] === root).length, 1);
  assert.equal(values.mock.calls.filter((call) => call.arguments[0] === child).length, 1);
  assert.equal(root.first, root.second);
  assert.equal(Object.isFrozen(root), true);
  assert.equal(Object.isFrozen(child), true);
  assert.equal(child.value, 1);
  assert.throws(() => { child.value = 2; }, TypeError);
});

it("reuses a completed graph when an alias outlives its proof during traversal", (t) => {
  const shared = { value: 1 };
  const root = {
    first: shared,
    values: Array.from({ length: 100_000 }, (_, value) => ({ value })),
    last: shared,
  };
  freezeExecutionValue(root);

  const values = t.mock.method(Object, "values");
  assert.equal(freezeExecutionValue(root), root);
  assert.equal(values.mock.callCount(), 0);
  assert.equal(root.first, root.last);
  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(root.values.at(-1)), true);
});

it("observes accessors on every call and freezes every returned value", () => {
  let reads = 0;
  const returned = [];
  const root = { get child() { reads++; const value = { number: reads }; returned.push(value); return value; } };
  freezeExecutionValue(root); freezeExecutionValue(root);
  assert.equal(reads, 2);
  assert.deepEqual(returned, [{ number: 1 }, { number: 2 }]);
  assert.equal(returned.every(Object.isFrozen), true);
});

it("does not retain a data-container proof after a getter replaces itself", () => {
  const first = {}, second = {};
  const root = {};
  Object.defineProperty(root, "child", { enumerable: true, configurable: true, get() {
    delete root.child; root.child = second; return first;
  } });
  freezeExecutionValue(root);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), false, "the original traversal visits values captured before the getter replaces its property");
  freezeExecutionValue(root);
  assert.equal(Object.isFrozen(second), true, "the next traversal must visit the replacement");
});

it("keeps proxy observations live when nested in a plain container", () => {
  let reads = 0;
  const target = { child: {} };
  const proxy = new Proxy(target, { get(object, name, receiver) {
    if (name === "child") reads++;
    return Reflect.get(object, name, receiver);
  } });
  const root = { proxy };
  freezeExecutionValue(root); freezeExecutionValue(root);
  assert.equal(reads, 2);
  assert.equal(Object.isFrozen(target.child), true);
});

it("retains repeated traversal of class-instance accessors", () => {
  let reads = 0;
  class Value {
    constructor() { Object.defineProperty(this, "child", { enumerable: true, get() { reads++; return { reads }; } }); }
  }
  const value = new Value();
  freezeExecutionValue({ value }); freezeExecutionValue({ value });
  assert.equal(reads, 2);
  assert.equal(Object.isFrozen(value), true);
});

it("terminates on cycles and preserves alias identity", () => {
  const first = {}, second = { first };
  first.second = second;
  assert.equal(freezeExecutionValue(first), first);
  assert.equal(freezeExecutionValue(first), first);
  assert.equal(first.second.first, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});

it("preserves failures from proxy observation without retaining a false freeze proof", () => {
  const failure = new Error("observation refused");
  let attempts = 0;
  const value = new Proxy({}, { ownKeys() { attempts++; throw failure; } });
  for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => freezeExecutionValue(value), (error) => error === failure);
  assert.equal(attempts, 2);
});


it("freezes the complete owned graph beneath a shallow-frozen class record", () => {
  class Record {
    constructor(value) { this.value = value; }
  }
  const nested = { list: [{ value: "original" }] };
  const record = Object.freeze(new Record(nested));
  assert.equal(freezeExecutionValue(record), record);
  assert.equal(freezeExecutionValue(record), record);
  for (const value of [record, nested, nested.list, nested.list[0]]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { nested.list[0].value = "changed"; }, TypeError);
  assert.equal(record.value.list[0].value, "original");
});

it("preserves native typed-view freeze outcomes as the backing buffer changes", () => {
  const buffers = [new ArrayBuffer(0), new ArrayBuffer(4)];
  if (typeof ArrayBuffer.prototype.resize === "function") buffers.push(new ArrayBuffer(0, { maxByteLength: 8 }));
  for (const buffer of buffers) {
    const view = new Uint8Array(buffer), reference = new Uint8Array(buffer);
    const compare = () => {
      let nativeFailure = null, actualFailure = null;
      try { Object.freeze(reference); } catch (error) { nativeFailure = error.constructor; }
      try { assert.equal(freezeExecutionValue(view), view); } catch (error) { actualFailure = error.constructor; }
      assert.equal(actualFailure, nativeFailure);
      if (actualFailure === null) assert.equal(Object.isFrozen(view), true);
    };
    compare(); compare();
    if (buffer.resizable) {
      buffer.resize(4); compare();
      buffer.resize(0); compare();
    }
  }
});
