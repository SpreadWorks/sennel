import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  ChildExitObservation, ProcessExecutionCheckoutIdentity, ProcessExecutionStopReceipt,
  ProcessExecutorIdentity, ProcessOutputState, ProcessExecutionValueEncoding, ProcessExecutionControlFailure, executionValueDigest,
} from "../../src/lib/process-execution-values.js";
import {
  RuntimeRequestAcceptance, RuntimeRequestHistorySection, RuntimeRequestCompletionSection,
  RuntimeRequestHistoryBlock, RuntimeRequestCompletionBlock, RuntimeRequestCompletionCarrier, RuntimeRequestContinuationBlock,
  RuntimeRequestContinuationChain, RuntimeRequestBlockEncodingPlan, runtimeRequestBlockIdentity,
} from "../../src/lib/process-execution-request-block.js";
import { ProcessExecutionRuntimeRequestBlockData } from "../../src/lib/process-execution-runtime.js";

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const ids = Object.freeze({
  execution: "11111111-1111-4111-8111-111111111111",
  call: "22222222-2222-4222-8222-222222222222",
  owner: "33333333-3333-4333-8333-333333333333",
  capability: "44444444-4444-4444-8444-444444444444",
  executor: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
  claim: "77777777-7777-4777-8777-777777777777",
  request: "88888888-8888-4888-8888-888888888888",
  foreign: "99999999-9999-4999-8999-999999999999",
});

function nearCapFinishValue() {
  // Pure typed data, not a produced child receipt or physical authority.
  // No revision8 registry is fabricated: only the actual private finish wire
  // and original request encoders' individual bounds are checked here.
  const checkoutIdentity = new ProcessExecutionCheckoutIdentity({
    mainRoot: path.resolve("pure-codec-input"), executionRoot: path.resolve("pure-codec-input"),
    mainDevice: "1", mainInode: "1", checkoutDevice: "1", checkoutInode: "1",
  });
  const executor = new ProcessExecutorIdentity({ executorId: ids.executor, executorSession: ids.session, launchClaim: ids.claim });
  const observation = new ChildExitObservation({ executor, kind: "exited", code: 0,
    observedAt: "2026-10-31T00:00:00.000Z" });
  const output = new ProcessOutputState({ stdoutBytes: 0, stderrBytes: 0, completion: "complete", cutoffAt: "2026-10-31T00:00:00.000Z" });
  const receiptFor = outcome => new ProcessExecutionStopReceipt({ schemaVersion: 4, scope: "registered-executions",
    executionId: ids.execution, callId: ids.call, ownerEpoch: 1, checkoutIdentity,
    binding: null, invocation: null, invocationDigest: executionValueDigest(null), executor, observation, output,
    closureRevision: 1, descendants: [], stopOperation: null, outcomeDigest: executionValueDigest(outcome) });
  const privateValue = (outcome, receipt) => ({ schemaVersion: 3, scope: "registered-executions",
    executionId: ids.execution, callId: ids.call, ownerToken: ids.owner, capability: ids.capability,
    executor: executor.toJSON(), observation: observation.toJSON(), state: "finished", outcome, receipt: receipt.toJSON() });
  const emptyOutcome = { z: "", a: null, unicode: "€☃🙂" };
  const emptyPrivate = new ProcessExecutionValueEncoding(privateValue(emptyOutcome, receiptFor(emptyOutcome)));
  const outcome = { ...emptyOutcome, z: "x".repeat(MAX_RECORD_BYTES - Buffer.byteLength(emptyPrivate.text())) };
  const receipt = receiptFor(outcome);
  const privateEncoding = new ProcessExecutionValueEncoding(privateValue(outcome, receipt));
  assert.equal(Buffer.byteLength(privateEncoding.text()), MAX_RECORD_BYTES,
    "the unchanged original private finish encoding must fit its exact16MiB bound");
  const acceptance = new RuntimeRequestAcceptance({ requestId: ids.request, operation: "finish",
    payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64) });
  const response = { ok: true, value: receipt.toJSON() };
  const request = { ...acceptance.toJSON(), response };
  const requestEncoding = new ProcessExecutionValueEncoding(request);
  const originalRequestEnvelope = new ProcessExecutionValueEncoding({ payload: request, digest: requestEncoding.digest });
  assert.ok(Buffer.byteLength(originalRequestEnvelope.text()) <= MAX_RECORD_BYTES,
    "the original individual request encoding remains inside the same cap");
  const history = new RuntimeRequestHistorySection({ version: 9, executionId: ids.execution, acceptance, previous: null });
  const historyBlockId = runtimeRequestBlockIdentity(history, "history");
  const section = new RuntimeRequestCompletionSection({ version: 9, executionId: ids.execution, acceptance,
    history: history.reference(historyBlockId), previous: null, response, observation: null,
    settlement: { callId: ids.call, outcome } });
  const block = new RuntimeRequestCompletionBlock({ version: 9, executionId: ids.execution,
    blockId: runtimeRequestBlockIdentity(section, "completion"), kind: "completion", sections: [section] });
  assert.ok(block.encodedByteLength() > MAX_RECORD_BYTES,
    "valid finish values need continuation because the ordinary completion framing exceeds the private sink");
  return { section, block, responseText: JSON.stringify(response), sectionText: JSON.stringify(section.toJSON()) };
}

function decodePhysical(record, namespace = ids.execution) {
  const bytes = Buffer.from(record.encodedRecord());
  assert.equal(bytes.length, record.encodedByteLength());
  assert.ok(bytes.length <= MAX_RECORD_BYTES, "no continuation physical record may exceed the original cap");
  return new ProcessExecutionRuntimeRequestBlockData(`requests/${namespace}/blocks/${record.blockId}.json`, bytes).decode();
}
function decodedPlan(plan) {
  const records = plan.physicalRecords.map(record => decodePhysical(record));
  const carriers = records.filter(record => record instanceof RuntimeRequestCompletionCarrier);
  assert.equal(carriers.length, 1);
  const pieces = new Map(records.filter(record => record instanceof RuntimeRequestContinuationBlock).map(record => [record.blockId, record]));
  assert.ok(pieces.size >= 2);
  return { carrier: carriers[0], pieces };
}
function restore(carrier, pieces) {
  const chain = new RuntimeRequestContinuationChain(carrier);
  while (chain.nextReference !== null) chain.append(pieces.get(chain.nextReference.blockId));
  return chain.restore();
}

test("history captures preserve exact section bytes, references and digests through appends and physical decoding", () => {
  const input = { version: 9, executionId: ids.execution,
    acceptance: { requestId: ids.request, operation: "finish", payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64) },
    previous: null };
  const original = JSON.stringify(input);
  const first = new RuntimeRequestHistorySection(input);
  assert.ok(first.valueEncoding instanceof ProcessExecutionValueEncoding);
  assert.equal(first.valueEncoding.text(), original);
  assert.equal(first.valueEncoding.digest, first.digest);
  assert.equal(first.byteLength, Buffer.byteLength(original));
  input.acceptance.operation = "failure";
  assert.equal(first.valueEncoding.text(), original, "producer changes cannot alter captured acceptance bytes");
  const blockId = runtimeRequestBlockIdentity(first, "history");
  const block = new RuntimeRequestHistoryBlock({ version: 9, executionId: ids.execution,
    blockId, kind: "history", sections: [first] });
  const second = new RuntimeRequestHistorySection({ version: 9, executionId: ids.execution,
    acceptance: { ...first.acceptance.toJSON(), requestId: ids.foreign }, previous: first.reference(blockId) });
  const appended = block.append(second);
  for (const value of [block, appended]) {
    const payload = value.toJSON();
    const expected = JSON.stringify({ payload, digest: executionValueDigest(payload) });
    assert.equal(value.encodedRecord(), expected);
    assert.equal(value.encodedByteLength(), Buffer.byteLength(expected));
    const restored = decodePhysical(value);
    assert.equal(restored.encodedRecord(), expected);
    assert.deepEqual(restored.sections.map(section => section.digest), value.sections.map(section => section.digest));
    assert.deepEqual(restored.sections.map(section => section.valueEncoding.text()), value.sections.map(section => section.valueEncoding.text()));
    assert.equal(restored.sections[0].acceptance.operation, "finish");
  }
  assert.ok(decodePhysical(appended).sections[1].previous.matches(first.reference(blockId)));
  assert.equal(block.encodedRecord(), JSON.stringify({ payload: block.toJSON(), digest: executionValueDigest(block.toJSON()) }));
});

test("literal and pooled completion blocks retain the exact ordinary JSON envelope through physical decoding", () => {
  const response = { ok: true, value: { stopSignal: null, stopRequested: false, stopRemainingMs: null,
    timedOut: false, aborted: false, descendantsSettled: true, status: "running",
    controlFailure: new ProcessExecutionControlFailure("control-failed", "日本語 😀 ".repeat(128)).toJSON() } };
  const section = (requestId, previous) => new RuntimeRequestCompletionSection({ version: 9, executionId: ids.execution,
    acceptance: new RuntimeRequestAcceptance({ requestId, operation: "read-control", payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64) }),
    history: null, previous, response, observation: null, settlement: null });
  const first = section(ids.request, null), blockId = runtimeRequestBlockIdentity(first, "completion");
  const second = section(ids.foreign, first.reference(blockId));
  for (const sections of [[first], [first, second]]) {
    const block = new RuntimeRequestCompletionBlock({ version: 9, executionId: ids.execution,
      blockId, kind: "completion", sections });
    const payload = block.toJSON();
    assert.equal(Object.hasOwn(payload, "responses"), sections.length === 2);
    const expected = JSON.stringify({ payload, digest: executionValueDigest(payload) });
    assert.equal(block.encodedRecord(), expected);
    assert.equal(block.encodedByteLength(), Buffer.byteLength(expected));
    const restored = decodePhysical(block);
    assert.deepEqual(restored.sections.map(value => value.response), sections.map(() => response));
    assert.deepEqual(restored.sections.map(value => value.digest), sections.map(value => value.digest));
  }
});

test("a legal individual finish value preserves its full original response and settlement through bounded continuation records", () => {
  const input = nearCapFinishValue();
  const plan = RuntimeRequestBlockEncodingPlan.create(input.block);
  const { carrier, pieces } = decodedPlan(plan);
  const restored = restore(carrier, pieces);
  assert.equal(restored.sections.length, 1);
  assert.ok(JSON.stringify(restored.sections[0].toJSON()) === input.sectionText,
    "the complete original section JSON, key order and nulls must survive physical readback");
  assert.ok(JSON.stringify(restored.sections[0].response) === input.responseText,
    "the exact original receipt response cannot be reconstructed or reordered");
  assert.equal(restored.sections[0].digest, input.section.digest);
  assert.equal(restored.sections[0].byteLength, input.section.byteLength);
  assert.equal(restored.sections[0].previous, null);
  assert.equal(restored.sections[0].observation, null);
  assert.equal(restored.sections[0].response.value.invocation, null);
  assert.equal(restored.sections[0].response.value.stopOperation, null);
  assert.equal(restored.sections[0].settlement.callId, ids.call);
});

test("continued completion readback refuses missing pieces, foreign namespaces, changed physical digests and reordered original response text", () => {
  const input = nearCapFinishValue();
  const plan = RuntimeRequestBlockEncodingPlan.create(input.block);
  const { carrier, pieces } = decodedPlan(plan);
  const first = pieces.get(carrier.first.blockId);
  const incomplete = new RuntimeRequestContinuationChain(carrier);
  assert.throws(() => incomplete.restore(), TypeError);
  assert.throws(() => decodePhysical(first, ids.foreign),
    error => error.code === "PROCESS_EXECUTION_AUTHORITY_MISMATCH");
  const corruptEnvelope = JSON.parse(first.encodedRecord());
  corruptEnvelope.digest = corruptEnvelope.digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  assert.throws(() => new ProcessExecutionRuntimeRequestBlockData(
    `requests/${ids.execution}/blocks/${first.blockId}.json`, Buffer.from(JSON.stringify(corruptEnvelope))),
  error => error.code === "PROCESS_EXECUTION_RECORD_CORRUPT");

  // This is intentionally malformed boundary data: both response objects have
  // the same JSON value, but the complete original section commitment stays.
  const reordered = JSON.stringify({ value: input.section.response.value, ok: true });
  assert.deepEqual(JSON.parse(reordered), JSON.parse(input.responseText));
  assert.notEqual(reordered, input.responseText);
  const originalBytes = Buffer.from(input.responseText), replacement = Buffer.from(reordered);
  assert.equal(originalBytes.length, replacement.length);
  const changed = first.bytes;
  const offset = changed.indexOf(originalBytes);
  assert.ok(offset >= 0, "the receipt response occurs entirely in the first physical piece");
  assert.equal(changed.indexOf(originalBytes, offset + originalBytes.length), -1);
  replacement.copy(changed, offset);
  const altered = decodePhysical(new RuntimeRequestContinuationBlock({ ...first.toJSON(), data: changed.toString("base64") }));
  const alteredCarrier = decodePhysical(new RuntimeRequestCompletionCarrier({ ...carrier.toJSON(), first: altered.reference().toJSON() }));
  const changedPieces = new Map(pieces); changedPieces.set(altered.blockId, altered);
  assert.throws(() => restore(alteredCarrier, changedPieces), TypeError,
    "recommitted physical frames cannot change the original response JSON order under its original section SHA");
  assert.ok(JSON.stringify(restore(carrier, pieces).sections[0].toJSON()) === input.sectionText,
    "negative boundary fixtures must leave the original valid chain intact");
});
