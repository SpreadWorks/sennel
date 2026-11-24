import test from "node:test";
import assert from "node:assert/strict";
import { ManagedProcessFrameReader, MANAGED_PROCESS_MESSAGE_MAX_BYTES } from "../../src/lib/managed-process-protocol.js";

test("managed frames preserve split UTF-8, owned partial bytes and successive lines", () => {
  const frames = new ManagedProcessFrameReader();
  const first = Buffer.from("日").subarray(0, 2);
  assert.deepEqual([...frames.read(first)], []);
  first.fill(0);
  const rest = Buffer.concat([Buffer.from("日").subarray(2), Buffer.from("本😀\nsecond\nlast")]);
  assert.deepEqual([...frames.read(rest)], ["日本😀", "second"]);
  assert.deepEqual([...frames.read(Buffer.from("\n\n"))], ["last", ""]);
});

test("managed frame refusal counts bytes for complete and unfinished Unicode lines", () => {
  assert.equal(MANAGED_PROCESS_MESSAGE_MAX_BYTES, 32 * 1024 * 1024);
  const exact = new ManagedProcessFrameReader(8);
  assert.deepEqual([...exact.read(Buffer.from("😀"))], []);
  assert.deepEqual([...exact.read(Buffer.from("😀\n"))], ["😀😀"]);
  for (const tail of ["😀x", "😀x\n"]) {
    const frames = new ManagedProcessFrameReader(8);
    assert.deepEqual([...frames.read(Buffer.from("😀"))], []);
    assert.throws(() => [...frames.read(Buffer.from(tail))], { code: "PROCESS_EXECUTION_OUTPUT_LIMIT" });
  }
});

test("a consumer can finish at its final response without accepting a later frame", () => {
  const frames = new ManagedProcessFrameReader(2);
  const consumed = [];
  for (const frame of frames.read(Buffer.from("ok\nextra"))) {
    consumed.push(frame);
    break;
  }
  assert.deepEqual(consumed, ["ok"]);
});
