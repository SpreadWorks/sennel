import { isDeepStrictEqual } from "node:util";
import { PROCESS_EVIDENCE_MIGRATION_KEYS, artifactProcessStopReceipts } from "./process-evidence-artifact-encoding.js";
import { FlowExecutionSourceManifest } from "./flow-execution-observation.js";
import { ProcessEvidenceArtifactProducerGraph } from "./process-evidence-artifact-graph-migration.js";
import { ProcessExecutionEvidenceMigration } from "./process-execution-evidence-migration.js";
import { ProcessExecutionRecoveryCall, ProcessExecutionStopReceipt, ProcessStopArtifactEncoding, executionValueExact } from "./process-execution-values.js";
import { executionValueDigest as previousPromptEvidenceDigest } from "../flow/lib/flow-execution-contract.js";
import { PromptExecutionRecordEvidence } from "../flow/lib/prompt-execution-record-evidence.js";
import { PromptExecutionJournalSnapshot, PromptExecutionJournalRecord, PromptProcessStopObservation, PromptExecutionReservationContinuation } from "./prompt-execution-journal.js";

export { PROCESS_EVIDENCE_MIGRATION_KEYS } from "./process-evidence-artifact-encoding.js";

import { ProcessEvidenceMigrationRefusal } from "./process-evidence-migration-refusal.js";
export { ProcessEvidenceMigrationRefusal } from "./process-evidence-migration-refusal.js";

function assertHashBoundEvidenceCurrent(descriptor, value, processEvidence) {
  for (const receipt of artifactProcessStopReceipts(descriptor.logicalKey, value)) {
    if (receipt.schemaVersion === 3 && processEvidence !== null) {
      processEvidence.receipt(receipt);
    } else {
      if (receipt.schemaVersion !== 4) throw new ProcessEvidenceMigrationRefusal(
        `Previous hash-bound process evidence requires explicit producer-graph maintenance before migration: ${descriptor.relativePath}`, descriptor);
      new ProcessExecutionStopReceipt(receipt);
    }
  }
}

/** Exact source and replacement bytes; a pure value cannot publish a migration. */
export class ProcessEvidenceArtifactReplacement {
  #source;
  #target;
  constructor(descriptor, sourceBytes, value) {
    this.descriptor = descriptor;
    this.#source = Buffer.from(sourceBytes);
    this.#target = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    Object.freeze(this);
  }
  get sourceBytes() { return Buffer.from(this.#source); }
  get targetBytes() { return Buffer.from(this.#target); }
}

function currentReceipt(value) {
  return value.schemaVersion === 3 ? ProcessExecutionEvidenceMigration.retainedCompletion(value)
    : new ProcessExecutionStopReceipt(value);
}

function recoveryCalls(value) {
  return value.map((call) => new ProcessExecutionRecoveryCall({ ...call,
    receipt: call.receipt === null ? null : currentReceipt(call.receipt),
    revocation: call.revocation === null ? null : call.revocation.schemaVersion === 2
      ? ProcessExecutionEvidenceMigration.retainedCompletion(call.revocation) : call.revocation }).toStored());
}

function recoveryObservation(value, calls) {
  const current = value.schemaVersion === 3 ? ProcessExecutionEvidenceMigration.recoverySummary(value) : value;
  if (!isDeepStrictEqual(current.calls, calls.map((call) => new ProcessExecutionRecoveryCall(call).toJSON()))) {
    throw new TypeError("Migrated recovery observation differs from its original exact completion identities");
  }
  return current;
}

function continuation(value) {
  if (value.physicalEvidence.schemaVersion === 4 && value.calls.every((call) => call.receipt === null || call.receipt.schemaVersion === 4)
    && value.calls.every((call) => call.revocation === null || call.revocation.schemaVersion === 3)
    && value.history.every((entry) => entry.physicalEvidence.schemaVersion === 4)) {
    return PromptExecutionReservationContinuation.fromJSON(value).toJSON();
  }
  const projected = { ...reservationProof(value), history: value.history.map(reservationProof) };
  return PromptExecutionReservationContinuation.fromJSON(projected).toJSON();
}

function reservationProof(value) {
  const calls = recoveryCalls(value.calls);
  return { ...value, calls, physicalEvidence: recoveryObservation(value.physicalEvidence, calls) };
}

function snapshot(value) {
  const projected = { ...value, batches: value.batches.map((batch) => ({ ...batch,
    ...(batch.processStops === undefined ? {} : { processStops: batch.processStops.map((stop) =>
      PromptProcessStopObservation.fromJSON({ ...stop, receipt: currentReceipt(stop.receipt).toJSON() }).toJSON()) }),
    ...(batch.reservationContinuation === undefined ? {} : { reservationContinuation: continuation(batch.reservationContinuation) }),
  })) };
  return PromptExecutionJournalSnapshot.fromJSON(projected);
}

function record(value) {
  if (value.event === "physical-accounted") {
    const calls = recoveryCalls(value.calls);
    return { ...value, calls, physicalEvidence: recoveryObservation(value.physicalEvidence, calls) };
  }
  const restored = new PromptExecutionJournalRecord({ event: value.event,
    snapshot: snapshot(value.snapshot) }).toJSON();
  executionValueExact(value, { ...restored, snapshot: value.snapshot });
  return restored;
}

class PromptEvidenceDocument {
  constructor(descriptor, bytes, value) {
    this.descriptor = descriptor; this.bytes = bytes; this.source = value;
    const scope = descriptor.relativePath.match(/\/(?:events|progress)\/([^/]+)/)?.[1]?.replace(/\.json$/, "");
    if (scope === undefined) throw new TypeError("Prompt document lacks its scope namespace");
    this.scope = `${value.contractId}/${scope}`;
    this.projected = { ...value, record: record(value.record) };
    if (!isDeepStrictEqual(value.record, this.projected.record)
      && value.digest !== previousPromptEvidenceDigest(value.record)) throw new TypeError("Previous Prompt document differs from its exact original record");
    this.projected.digest = PromptExecutionRecordEvidence.digest(this.projected.record);
    if (this.projected.digest !== value.digest) throw new TypeError("Canonical evidence migration changed its original Prompt record identity");
    Object.freeze(this);
  }
}

/** A pending historical marker is data only after the authoritative
 * scope frontier proves its consumption through the complete original chain. */
class PromptReservationMigrationHistory {
  #events = new Map();
  #frontiers = new Map();
  #documents;
  constructor(documents) {
    this.#documents = documents;
    for (const document of documents) {
      if (document.source.record.event === "physical-accounted") continue;
      const key = `${document.scope}/${document.source.digest}`;
      const previous = this.#events.get(key);
      if (previous !== undefined && !isDeepStrictEqual(previous.source, document.source)) {
        throw new TypeError("Prompt reservation history has conflicting original event identities");
      }
      this.#events.set(key, document);
      if (document.descriptor.logicalKey === "prompt.execution.progress") {
        if (this.#frontiers.has(document.scope)) throw new TypeError("Prompt reservation history has duplicate canonical frontiers");
        this.#frontiers.set(document.scope, document);
      }
    }
    Object.freeze(this);
  }
  #assertPredecessor(document, frontier) {
    const seen = new Set();
    let current = frontier;
    while (current.source.digest !== document.source.digest) {
      if (seen.has(current.source.digest)) throw new TypeError("Prompt reservation history contains a predecessor cycle");
      seen.add(current.source.digest);
      const previous = this.#events.get(`${document.scope}/${current.source.previousDigest}`);
      if (previous === undefined || previous.source.sequence !== current.source.sequence - 1) {
        throw new TypeError("Prompt reservation history lacks its complete original predecessor chain");
      }
      current = previous;
    }
  }
  #consumedBy(marker, wanted) {
    if (!marker.pending && marker.id === wanted.id) return true;
    return marker.history.some((entry, index) => {
      const ancestor = new PromptExecutionReservationContinuation({ authorizationId: marker.authorizationId,
        executionContractId: marker.executionContractId, ...entry, history: marker.history.slice(0, index) });
      return ancestor.id === wanted.id;
    });
  }
  assertResolvedHistoricalReservations() {
    for (const document of this.#documents) {
      if (document.source.record.event === "physical-accounted") continue;
      for (const [index, batch] of document.source.record.snapshot.batches.entries()) {
        const source = batch.reservationContinuation;
        const projected = document.projected.record.snapshot.batches[index].reservationContinuation;
        if (source === undefined || source.consumedClaim !== null || isDeepStrictEqual(source, projected)) continue;
        const wanted = PromptExecutionReservationContinuation.fromJSON(projected);
        const frontier = this.#frontiers.get(document.scope);
        if (frontier === undefined) throw new ProcessEvidenceMigrationRefusal(
          "An unused previous process reservation has no canonical scope frontier");
        this.#assertPredecessor(document, frontier);
        const consumed = frontier.projected.record.snapshot.batches.some(entry => entry.reservationContinuation !== undefined
          && this.#consumedBy(PromptExecutionReservationContinuation.fromJSON(entry.reservationContinuation), wanted));
        if (!consumed) throw new ProcessEvidenceMigrationRefusal(
          "An unused previous process reservation requires its original authority to be resolved before evidence-format migration");
      }
    }
  }
}

/** Owns only protocol-defined artifact fields and Prompt predecessor links.
 * Opaque provider responses, user invocation/binding data and Activity facts
 * are never recursively searched or rewritten.
 */
export class ProcessEvidenceArtifactMigration {
  constructor(entries, { producerGraph = null, processEvidence = null } = {}) {
    if (producerGraph !== null && !(producerGraph instanceof ProcessEvidenceArtifactProducerGraph)
      || processEvidence !== null && !(processEvidence instanceof ProcessStopArtifactEncoding)
      || producerGraph !== null && processEvidence !== null) {
      throw new TypeError("Process migration requires one typed original graph or current published encoding");
    }
    const encoding = producerGraph?.processEvidence ?? processEvidence;
    const replacements = [], documents = [];
    for (const { descriptor, bytes } of entries) {
      if (!PROCESS_EVIDENCE_MIGRATION_KEYS.includes(descriptor.logicalKey)) throw new TypeError("Process evidence migration received an unrelated artifact");
      producerGraph?.assertInput(descriptor, bytes);
      const value = JSON.parse(bytes.toString("utf8"));
      if (!["execution.source.manifest", "prompt.execution.progress", "prompt.execution.event"].includes(descriptor.logicalKey)) {
        assertHashBoundEvidenceCurrent(descriptor, value, encoding);
        continue;
      }
      if (descriptor.logicalKey === "execution.source.manifest") {
        if (value.schemaRevision === 1 && value.checkoutIdentity !== null) ProcessExecutionEvidenceMigration.checkout(value.checkoutIdentity);
        const projected = FlowExecutionSourceManifest.fromJSON({ ...value, schemaRevision: 2 }).toJSON();
        if (![1, 2].includes(value.schemaRevision)) throw new TypeError("Previous execution source manifest version is unsupported");
        executionValueExact(value, { ...projected, schemaRevision: value.schemaRevision });
        if (!isDeepStrictEqual(value, projected)) replacements.push(new ProcessEvidenceArtifactReplacement(descriptor, bytes, projected));
      } else documents.push(new PromptEvidenceDocument(descriptor, bytes, value));
    }
    new PromptReservationMigrationHistory(documents).assertResolvedHistoricalReservations();
    const identities = new Map();
    for (const document of documents) {
      const key = `${document.scope}/${document.source.digest}`;
      const previous = identities.get(key);
      if (previous !== undefined && previous !== document.projected.digest) throw new TypeError("Prompt source digest has conflicting replacements");
      identities.set(key, document.projected.digest);
    }
    for (const document of documents) {
      if (document.source.previousDigest !== null) {
        const digest = identities.get(`${document.scope}/${document.source.previousDigest}`);
        if (digest === undefined) throw new TypeError("Prompt evidence migration cannot reconstruct a missing predecessor document");
        document.projected.previousDigest = digest;
      }
      if (!isDeepStrictEqual(document.source, document.projected)) replacements.push(new ProcessEvidenceArtifactReplacement(document.descriptor, document.bytes, document.projected));
    }
    this.replacements = Object.freeze(replacements);
    this.proofs = producerGraph?.proofs ?? Object.freeze([]);
    Object.freeze(this);
  }
  get changed() { return this.replacements.length !== 0 || this.proofs.length !== 0; }
}
