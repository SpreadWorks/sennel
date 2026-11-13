import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import {
  ProcessExecutionRuntimeVersion8LogicalInventory,
  ProcessExecutionRuntimeVersion8Conversion,
  ProcessExecutionRuntimeVersion10LogicalInventory,
  ProcessExecutionRuntimeRequestBlockData,
} from "../../src/lib/process-execution-runtime.js";
import { RuntimeStandaloneRequestDocument } from "../../src/lib/process-execution-request-block.js";

import { assertProcessRuntimeEvidencePreserved } from "../support/assertions/process-evidence-migration.js";

const fixture = new URL("../fixtures/process-runtime-record-v8-canonical/", import.meta.url);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const text = value => JSON.stringify(value);
const records = new Map([
  ["registry.json", "09965345089c60b4a569f6190fd3f7a6cb05799b00150fa1ac14f256f41ce596"],
  ["archives/f5052b64-f6fe-4105-9a35-56f31d4d91b7.json", "660b2a33afcc267083688fca5fbbf8cd6204653ae740c2ba4a4a0959d846d669"],
  ["archives/2e9ded1e-d0db-4fa7-ae6b-30b18c03756a.json", "7a55b06f21daaf290d22c04fb5313d79f5ec39102984af2f76462c421c887939"],
]);

function original() {
  const captured = [];
  for (const [relative, expected] of records) {
    const bytes = fs.readFileSync(new URL(relative, fixture));
    assert.equal(sha(bytes), expected, relative);
    const envelope = JSON.parse(bytes);
    assert.equal(envelope.payload.version, 8);
    assert.equal(sha(text(envelope.payload)), envelope.digest);
    captured.push(envelope.payload);
  }
  return { registry: captured[0], archives: captured.slice(1) };
}

function currentInput(conversion) {
  const registry = JSON.parse(conversion.targets.find(target => target.relativePath === "registry.json").bytes).payload;
  const archives = conversion.targets.filter(target => target.relativePath.startsWith("archives/"))
    .map(target => JSON.parse(target.bytes).payload);
  const blocks = conversion.targets.filter(target => /^requests\/[^/]+\/blocks\//.test(target.relativePath))
    .map(target => new ProcessExecutionRuntimeRequestBlockData(target.relativePath, target.bytes));
  return { registry, archives, blocks };
}

test("authentic revision-8 canonical records retain every original response and closure after strict revision-10 readback", () => {
  const input = original();
  const expected = new ProcessExecutionRuntimeVersion8LogicalInventory(input).logicalInventory;
  const conversion = new ProcessExecutionRuntimeVersion8Conversion(input);
  const restored = new ProcessExecutionRuntimeVersion10LogicalInventory(currentInput(conversion)).logicalInventory;
  assertProcessRuntimeEvidencePreserved(expected, restored);
  assert.deepEqual(restored.executions.map(execution => execution.ownerEpoch), [1, 2]);
  assert.deepEqual(restored.executions.flatMap(execution => execution.calls.map(call => call.status)), ["revoked", "stopped"]);
  for (const execution of expected.executions) {
    const actual = restored.executions.find(value => value.executionId === execution.executionId);
    assert.equal(text(actual.closure), text(execution.closure));
    assert.equal(text(actual.events), text(execution.events));
  }
  const provenance = JSON.parse(fs.readFileSync(new URL("provenance.json", fixture)));
  assert.equal(provenance.sourceVersion, 8);
  assert.equal(provenance.producerAssetSha256, "116edd38534d8b14947651eee68438b8a5164158852a8b81819ca52e5fab9e39");
  assert.equal(provenance.notPhysicalMigrationFixture, true);
  assert.deepEqual(new Map(provenance.records.map(record => [record.relativePath, record.sha256])), records);
});

test("conversion targets are deterministic bounded bytes and cannot be mutated through their buffer getters", () => {
  const input = original();
  const before = text(input);
  const first = new ProcessExecutionRuntimeVersion8Conversion(input);
  const second = new ProcessExecutionRuntimeVersion8Conversion(input);
  assert.equal(first.targets.at(-1).relativePath, "registry.json");
  assert.equal(new Set(first.targets.map(target => target.relativePath)).size, first.targets.length);
  assert.deepEqual(first.targets.map(target => [target.relativePath, target.digest, target.byteLength]),
    second.targets.map(target => [target.relativePath, target.digest, target.byteLength]));
  for (const target of first.targets) {
    const bytes = target.bytes;
    assert.equal(bytes.length, target.byteLength);
    assert.ok(bytes.length <= 16 * 1024 * 1024);
    assert.equal(sha(bytes), target.digest);
    bytes.fill(0);
    assert.equal(sha(target.bytes), target.digest);
  }
  assert.equal(text(input), before);
});

test("explicit standalone conversion preserves completed and known-null evidence with namespace-bound checksums", () => {
  const input = original();
  const execution = input.archives.find(archive => archive.execution.calls.length > 0).execution;
  const observations = execution.requests.filter(request => request.operation === "observe");
  assert.equal(observations.length, 2);
  // These detached null-sidecar inputs exercise the decoder boundary; the
  // canonical original responses above remain intact and completed.
  const requests = observations.map((request, index) => ({ executionId: execution.executionId,
    request: { ...request, response: index === 0 ? null : request.response } }));
  const conversion = new ProcessExecutionRuntimeVersion8Conversion({ ...input, requests });
  const restored = new ProcessExecutionRuntimeVersion10LogicalInventory(currentInput(conversion)).logicalInventory;
  assert.equal(text(restored), text(conversion.logicalInventory));
  for (const { executionId, request } of requests) {
    const relative = `requests/${executionId}/${request.requestId}.json`;
    const envelope = JSON.parse(conversion.targets.find(target => target.relativePath === relative).bytes);
    const document = RuntimeStandaloneRequestDocument.fromEnvelope(executionId, request.requestId, envelope);
    assert.equal(text(document.requestRecord()), text(request));
    const foreignExecution = input.archives.find(archive => archive.execution.executionId !== executionId).execution.executionId;
    assert.throws(() => RuntimeStandaloneRequestDocument.fromEnvelope(foreignExecution, request.requestId, envelope), TypeError);
    const genericChecksum = { ...envelope, digest: sha(text(envelope.payload)) };
    assert.throws(() => RuntimeStandaloneRequestDocument.fromEnvelope(executionId, request.requestId, genericChecksum), TypeError);
  }
});

test("valid revision-8 pending and unmatched reserve replies preserve their exact literal order instead of using the latest call", () => {
  for (const pending of [false, true]) {
    const input = original();
    const execution = input.archives.find(archive => archive.execution.calls.length > 0).execution;
    const request = execution.requests.find(request => request.operation === "reserve");
    if (pending) request.response = null;
    else request.response.value.invocation = { second: "original opaque reply", first: [2, 1] };
    // Validate each detached variant before making a preservation claim. This
    // is a legal-input codec test, not a claim about a public native producer.
    const expected = new ProcessExecutionRuntimeVersion8LogicalInventory(input).logicalInventory;
    const conversion = new ProcessExecutionRuntimeVersion8Conversion(input);
    const restored = new ProcessExecutionRuntimeVersion10LogicalInventory(currentInput(conversion)).logicalInventory;
    assertProcessRuntimeEvidencePreserved(expected, restored);
    const result = restored.executions.find(value => value.executionId === execution.executionId)
      .requests.find(value => value.requestId === request.requestId);
    assert.equal(text(result.response), text(request.response));
  }
});

test("strict current decoding rejects missing, duplicate, changed and foreign request blocks", () => {
  const conversion = new ProcessExecutionRuntimeVersion8Conversion(original());
  const input = currentInput(conversion);
  assert.ok(input.blocks.length > 0);
  assert.throws(() => new ProcessExecutionRuntimeVersion10LogicalInventory({ ...input, blocks: input.blocks.slice(1) }),
    { code: "PROCESS_EXECUTION_RECORD_MISSING" });
  assert.throws(() => new ProcessExecutionRuntimeVersion10LogicalInventory({ ...input, blocks: [...input.blocks, input.blocks[0]] }),
    { code: "PROCESS_EXECUTION_RECORD_CORRUPT" });
  const target = conversion.targets.find(target => /^requests\/[^/]+\/blocks\//.test(target.relativePath));
  const envelope = JSON.parse(target.bytes);
  envelope.digest = "0".repeat(64);
  assert.throws(() => new ProcessExecutionRuntimeRequestBlockData(target.relativePath, Buffer.from(text(envelope))),
    { code: "PROCESS_EXECUTION_RECORD_CORRUPT" });
  const foreignExecution = input.archives.find(archive => archive.execution.executionId !== input.blocks[0].executionId).execution.executionId;
  const foreign = new ProcessExecutionRuntimeRequestBlockData(
    input.blocks[0].relativePath.replace(input.blocks[0].executionId, foreignExecution), target.bytes);
  assert.throws(() => foreign.decode(), { code: "PROCESS_EXECUTION_AUTHORITY_MISMATCH" });
});
