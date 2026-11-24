import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowArtifactCatalog } from "../../src/lib/flow-version.js";
import { ProcessEvidenceArtifactMigration, PROCESS_EVIDENCE_MIGRATION_KEYS } from "../../src/lib/process-evidence-artifact-migration.js";
import { executionValueDigest as promptDigest } from "../../src/flow/lib/flow-execution-contract.js";
import { executionValueDigest as storedDigest } from "../../src/lib/process-execution-values.js";
import { PromptExecutionReservationContinuation, PromptExecutionJournalRecord, PromptExecutionJournalSnapshot } from "../../src/lib/prompt-execution-journal.js";
import { PromptExecutionRecordEvidence } from "../../src/flow/lib/prompt-execution-record-evidence.js";

function migratedProgress() {
  const seed = new URL("../fixtures/process-evidence-v1/specs/001-stop-contract/001/", import.meta.url);
  const catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(new URL("artifact-catalog.json", seed))));
  const entries = catalog.artifacts.filter(descriptor => PROCESS_EVIDENCE_MIGRATION_KEYS.includes(descriptor.logicalKey))
    .map(descriptor => ({ descriptor, bytes: fs.readFileSync(new URL(descriptor.relativePath, seed)) }));
  const migration = new ProcessEvidenceArtifactMigration(entries);
  const replacement = migration.replacements.find(entry => entry.descriptor.logicalKey === "prompt.execution.progress");
  assert.ok(replacement);
  return { source: JSON.parse(replacement.sourceBytes), current: JSON.parse(replacement.targetBytes),
    currentEntries: entries.map(entry => ({ ...entry, bytes: migration.replacements.find(change =>
      change.descriptor.relativePath === entry.descriptor.relativePath)?.targetBytes ?? entry.bytes })) };
}

test("a genuine old Prompt record retains its producer identity and predecessor after current evidence encoding", () => {
  const { source, current } = migratedProgress();
  assert.equal(current.digest, source.digest);
  assert.equal(current.previousDigest, source.previousDigest);
  assert.equal(PromptExecutionRecordEvidence.digest(current.record), source.digest);
  const stops = current.record.snapshot.batches.flatMap(batch => batch.processStops ?? []);
  assert.ok(stops.length > 0);
  assert.ok(stops.every(stop => stop.receipt.schemaVersion === 4));
});

test("Prompt identity hashing retains unexpected fields and opaque values for the normal reader to validate", () => {
  const { current } = migratedProgress();
  const original = PromptExecutionRecordEvidence.digest(current.record);
  for (const mutate of [
    value => { value.unexpected = true; },
    value => { value.snapshot.unexpected = true; },
    value => { value.snapshot.batches[0].unexpected = { processStop: { schemaVersion: 3, opaque: true } }; },
  ]) {
    const value = structuredClone(current.record);
    mutate(value);
    const changed = PromptExecutionRecordEvidence.digest(value);
    assert.notEqual(changed, original);
    assert.equal(PromptExecutionRecordEvidence.digest(value), changed);
  }
  assert.equal(PromptExecutionRecordEvidence.digest(current.record), original);
});


test("already-current retained Prompt evidence is a no-op under a repeated explicit format inspection", () => {
  const { currentEntries } = migratedProgress();
  const before = currentEntries.map(entry => Buffer.from(entry.bytes));
  assert.deepEqual(new ProcessEvidenceArtifactMigration(currentEntries).replacements, []);
  for (const [index, entry] of currentEntries.entries()) assert.deepEqual(entry.bytes, before[index]);
});


test("explicit old-format migration retains a consumed reservation's flat claim history and proof identities", () => {
  const seed = new URL("../fixtures/process-evidence-v1/specs/001-stop-contract/001/", import.meta.url);
  const catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(new URL("artifact-catalog.json", seed))));
  const events = catalog.artifacts.filter(entry => entry.logicalKey === "prompt.execution.event").map(descriptor =>
    ({ descriptor, value: JSON.parse(fs.readFileSync(new URL(descriptor.relativePath, seed))) }));
  const claimed = events.find(entry => entry.value.record.event === "claimed");
  const receipt = events.find(entry => entry.value.record.event === "process-stopped").value.record.snapshot.batches[0].processStops[0].receipt;
  // A detached codec model extending an authentic claim. It proves saved-format
  // conversion only; native reconciliation is covered by the recovery scenario.
  const source = structuredClone(claimed.value);
  const first = source.record.snapshot.batches[0].claim;
  const replacement = (claim, ordinal) => ({ ...claim, processIdentity: { ...claim.processIdentity,
    logicalInvocationId: `11111111-1111-4111-8111-${String(ordinal).padStart(12, "0")}`,
    providerAttemptId: `22222222-2222-4222-8222-${String(ordinal).padStart(12, "0")}` } });
  const second = replacement(first, 2), third = replacement(first, 3);
  const proof = claim => {
    const binding = { executionContractId: source.contractId };
    const invocation = { providerAttemptId: claim.processIdentity.providerAttemptId,
      logicalInvocationId: claim.processIdentity.logicalInvocationId };
    const summary = { schemaVersion: 3, checkoutIdentity: receipt.checkoutIdentity, binding, invocation,
      inventoryDigest: "a".repeat(64), ownerEpoch: 1, calls: [], nonExecution: { schemaVersion: 1,
        checkoutIdentity: receipt.checkoutIdentity, binding, invocation, inventoryDigest: "a".repeat(64), ownerEpoch: 1,
        executions: [{ executionId: receipt.executionId, ownerEpoch: 1, authorityState: "closed" }], reservationBeforeSpawn: true } };
    const id = storedDigest(summary);
    return { ...summary, id, digest: id };
  };
  const continuation = { authorizationId: "detached-previous-reservation", executionContractId: source.contractId,
    previousClaim: second, physicalEvidence: proof(second), calls: [], consumedClaim: third,
    history: [{ previousClaim: first, physicalEvidence: proof(first), calls: [], consumedClaim: second }] };
  const { consumedClaim, ...identity } = continuation;
  const originalId = storedDigest(identity);
  source.record.snapshot.batches[0].claim = third;
  source.record.snapshot.batches[0].reservationContinuation = continuation;
  source.previousDigest = null;
  source.digest = promptDigest(source.record);
  const bytes = Buffer.from(JSON.stringify(source));
  const migration = new ProcessEvidenceArtifactMigration([{ descriptor: claimed.descriptor, bytes }]);
  assert.equal(migration.replacements.length, 1);
  const current = JSON.parse(migration.replacements[0].targetBytes);
  assert.equal(current.digest, source.digest);
  assert.deepEqual(new PromptExecutionJournalRecord({ event: current.record.event,
    snapshot: PromptExecutionJournalSnapshot.fromJSON(current.record.snapshot) }).toJSON(), current.record);
  const restored = PromptExecutionReservationContinuation.fromJSON(current.record.snapshot.batches[0].reservationContinuation);
  assert.equal(restored.id, originalId);
  assert.equal(restored.history.length, 1);
  assert.deepEqual(restored.history[0].consumedClaim, restored.previousClaim);
  assert.equal(restored.history[0].physicalEvidence.schemaVersion, 4);
  assert.equal(restored.history[0].physicalEvidence.id, continuation.history[0].physicalEvidence.id);
  assert.equal(restored.physicalEvidence.id, continuation.physicalEvidence.id);
  assert.deepEqual(new ProcessEvidenceArtifactMigration([{ descriptor: claimed.descriptor,
    bytes: migration.replacements[0].targetBytes }]).replacements, []);
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(source)));
});
