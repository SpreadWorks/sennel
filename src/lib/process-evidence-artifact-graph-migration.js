/** Explicit graph inspection for migration; ordinary artifact readers never import it. */
import { FlowArtifactCatalog, FlowArtifactDescriptor, FlowVersionLocation } from "./flow-version.js";
import { RegularFileSnapshot, MAX_IN_MEMORY_FILE_BYTES } from "./regular-file-snapshot.js";
import { PROCESS_EVIDENCE_MIGRATION_KEYS, REVIEW_PROCESS_EVIDENCE_KEYS,
  ProcessStopArtifactProof, artifactProcessStopReceipts } from "./process-evidence-artifact-encoding.js";
import { ProcessExecutionEvidenceMigration } from "./process-execution-evidence-migration.js";
import { ProcessExecutionStopReceipt, ProcessStopArtifactEncoding } from "./process-execution-values.js";
import { ProcessEvidenceMigrationRefusal } from "./process-evidence-migration-refusal.js";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactSpecReviewActivityEvidenceDocument } from "./flow-artifact-contract.js";
import { CanonicalSpecReview, SpecRevisionIdentity } from "../flow/lib/spec-review-artifacts.js";
import { CurrentFlowState, FlowActivity } from "../flow/lib/current-flow-state.js";
import { FlowExecutionContract } from "../flow/lib/flow-execution-contract.js";
import { FlowProcessStopEvidence } from "../flow/lib/process-runtime-evidence.js";
import { readExecutionContractFromView } from "../flow/lib/canonical-prompt-execution.js";
import { assertStoredReviewProcessStop } from "../flow/lib/canonical-review-artifacts.js";
import { CanonicalCommandAttemptArtifactHistory } from "../flow/lib/canonical-command-result.js";
import { SourceHandoffEvent } from "../flow/lib/worker-artifact-handoff.js";
import { readSourceHandoffAuthorityFromView } from "../flow/lib/source-handoff-persistence.js";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionRuntime, captureProcessExecutionCheckoutIdentity } from "./process-execution-runtime.js";

const graphToken = Symbol("validated original process evidence graph");

export class ProcessEvidenceArtifactInput {
  #snapshot;
  constructor(descriptor, snapshot) {
    if (!(descriptor instanceof FlowArtifactDescriptor) || !(snapshot instanceof RegularFileSnapshot)) {
      throw new TypeError("Process evidence input requires its captured catalog artifact");
    }
    descriptor.verifySnapshot(snapshot);
    this.descriptor = descriptor;
    this.#snapshot = snapshot;
    Object.freeze(this);
  }
  get bytes() { return this.#snapshot.bytes; }
  jsonDocument() { return JSON.parse(this.#snapshot.text()); }
  assertBytes(bytes) { this.descriptor.verifyBytes(bytes); }
}

/** A read capability for the already captured original catalog, never a Flow executor. */
class ProcessEvidenceMigrationView {
  constructor(location, catalog, state, activities, processEvidence) {
    if (!(location instanceof FlowVersionLocation) || !(catalog instanceof FlowArtifactCatalog)
      || !(state instanceof CurrentFlowState) || !Array.isArray(activities)
      || activities.some(activity => !(activity instanceof FlowActivity))
      || processEvidence !== null && !(processEvidence instanceof ProcessStopArtifactEncoding)) {
      throw new TypeError("Original evidence view requires captured canonical typed facts");
    }
    this.location = location;
    this.catalog = catalog;
    this.state = state;
    this.activities = activities;
    this.processEvidence = processEvidence;
    Object.freeze(this);
  }
  readArtifactSnapshot(descriptor) {
    return this.catalog.readArtifact(this.location, descriptor.relativePath, { processEvidence: this.processEvidence });
  }
  readCatalogedArtifact(descriptor) { return this.readArtifactSnapshot(descriptor).bytes; }
}

class OriginalProcessExecutionContract {
  constructor(document, contract, activity) {
    if (!(contract instanceof FlowExecutionContract) || !(activity instanceof FlowActivity)
      || document.id !== contract.id) throw new TypeError("Original contract requires its exact canonical producer Activity");
    this.document = document;
    this.contract = contract;
    this.activity = activity;
    Object.freeze(this);
  }
}

/** Only complete original producer validation can mint proof additions. */
export class ProcessEvidenceArtifactProducerGraph {
  #inputs;
  constructor(token, inputs, processEvidence, proofs) {
    if (token !== graphToken) throw new TypeError("Process evidence producer graph requires complete original validation");
    this.#inputs = new Map(inputs.map(input => [input.descriptor.relativePath, input]));
    this.processEvidence = processEvidence;
    this.proofs = Object.freeze([...proofs]);
    Object.freeze(this);
  }
  assertInput(descriptor, bytes) {
    const input = this.#inputs.get(descriptor.relativePath);
    if (input === undefined || input.descriptor.hash !== descriptor.hash || input.descriptor.logicalKey !== descriptor.logicalKey) {
      throw new TypeError("Process migration input differs from its validated original graph");
    }
    input.assertBytes(bytes);
  }
}

/** Read-only original physical receipts from explicit current runtime storage.
 * Canonical Review serialization may reorder nested keys and cannot recover the
 * actual producer's wire digest. Only the retained original completion can.
 */
class OriginalProcessCompletionInventory {
  #inventories = new Map();
  constructor(mainRoot) { this.mainRoot = mainRoot; }
  receipt(value) {
    const projected = ProcessExecutionEvidenceMigration.retainedCompletion(value);
    const executionRoot = projected.checkoutIdentity.executionRoot;
    if (!this.#inventories.has(executionRoot)) this.#inventories.set(executionRoot,
      ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: this.mainRoot, executionRoot,
        checkoutIdentity: projected.checkoutIdentity }));
    const inventory = this.#inventories.get(executionRoot);
    if (!inventory.checkoutIdentity.matches(projected.checkoutIdentity)) {
      throw new ProcessEvidenceMigrationRefusal("Previous artifact receipt belongs to another retained checkout");
    }
    const execution = inventory.executions.find(entry => entry.executionId === projected.executionId);
    const call = execution?.calls.find(entry => entry.callId === projected.callId);
    const receipt = call?.receipt == null ? null : new ProcessExecutionStopReceipt(call.receipt);
    if (receipt === null || !isDeepStrictEqual(value, receipt.toEvidenceJSON())) {
      throw new ProcessEvidenceMigrationRefusal("Previous artifact receipt lacks its exact retained runtime completion");
    }
    return receipt;
  }
}

/** Captures previous boundary data without trusting its content or publishing it. */
export class ProcessEvidenceArtifactGraphSource {
  #proofs;
  constructor({ location, catalog }) {
    if (!(location instanceof FlowVersionLocation) || !(catalog instanceof FlowArtifactCatalog)) {
      throw new TypeError("Process evidence graph capture requires its canonical catalog location");
    }
    this.location = location;
    this.catalog = catalog;
    this.entries = Object.freeze(catalog.artifacts.filter(descriptor =>
      PROCESS_EVIDENCE_MIGRATION_KEYS.includes(descriptor.logicalKey) || descriptor.logicalKey === "execution.contract")
      .map(descriptor => new ProcessEvidenceArtifactInput(descriptor,
        descriptor.readPhysicalSnapshot(location, { maxBytes: MAX_IN_MEMORY_FILE_BYTES }))));
    const receipts = [];
    const originals = new OriginalProcessCompletionInventory(location.repositoryRoot);
    for (const input of this.entries) {
      const values = artifactProcessStopReceipts(input.descriptor.logicalKey, input.jsonDocument())
        .filter(receipt => receipt.schemaVersion === 3);
      if (values.length === 0) continue;
      const current = catalog.hasProcessStopProofs
        ? catalog.processStopEncoding(location, input.descriptor.logicalKey, [input.bytes]) : null;
      for (const receipt of values) receipts.push(current === null
        ? originals.receipt(receipt) : current.receipt(receipt));
    }
    this.processEvidence = receipts.length === 0 ? null : new ProcessStopArtifactEncoding(receipts);
    this.requiresProducerGraph = receipts.length !== 0 && !catalog.hasProcessStopProofs;
    this.#proofs = this.requiresProducerGraph
      ? this.processEvidence.receipts.map(receipt => new ProcessStopArtifactProof(receipt)) : [];
    Object.freeze(this);
  }
  get migrationInputs() {
    return this.entries.filter(input => PROCESS_EVIDENCE_MIGRATION_KEYS.includes(input.descriptor.logicalKey));
  }

  validate({ state, activities }) {
    const view = new ProcessEvidenceMigrationView(this.location, this.catalog, state, activities, this.processEvidence);
    const contracts = new Map();
    for (const input of this.entries.filter(entry => entry.descriptor.logicalKey === "execution.contract")) {
      const document = input.jsonDocument(), contract = FlowExecutionContract.fromJSON(document.contract);
      if (document.id !== contract.id || contracts.has(contract.id)) throw new TypeError("Original execution contracts have conflicting identities");
      const activity = activities.find(entry => entry.id === input.descriptor.activityId);
      readExecutionContractFromView(view, contract, { current: false });
      contracts.set(contract.id, new OriginalProcessExecutionContract(document, contract, activity));
    }
    const reviewStop = (value, nodeId, attempt = undefined) => {
      if (value === null || value === undefined) return;
      const receipt = ProcessExecutionStopReceipt.fromArtifact(value, this.processEvidence);
      const binding = receipt.binding.value;
      if (binding.nodeId !== nodeId || attempt !== undefined && binding.attemptSequence !== attempt) {
        throw new ProcessEvidenceMigrationRefusal("Original Review receipt differs from its owning producer");
      }
      const original = contracts.get(binding.executionContractId);
      if (original === undefined) throw new ProcessEvidenceMigrationRefusal("Original Review receipt lacks its canonical execution contract");
      assertStoredReviewProcessStop({ processStop: new FlowProcessStopEvidence(receipt),
        contractDocument: original.document, contractActivity: original.activity,
        state, activity: original.activity });
    };
    const assertReview = review => {
      const snapshot = FLOW_ARTIFACT_CONTRACTS.resolve("spec.snapshot", { revision: review.identity.revision.toString() });
      const bytes = view.readCatalogedArtifact(this.catalog.resolve(snapshot.relativePath));
      if (!review.identity.equals(SpecRevisionIdentity.fromBytes({ specId: state.specId,
        revision: review.identity.revision.value, bytes }))) {
        throw new ProcessEvidenceMigrationRefusal("Original Review differs from its immutable Spec snapshot");
      }
      if (review.processStop !== null) reviewStop(review.processStop, "spec-review");
    };
    const sourceEvents = new Map();
    for (const input of this.migrationInputs) {
      const key = input.descriptor.logicalKey, bytes = input.bytes;
      if (key === "spec.review") {
        const review = CanonicalSpecReview.fromBytes(bytes, { processEvidence: this.processEvidence });
        const expected = FLOW_ARTIFACT_CONTRACTS.resolve(key, { revision: review.identity.revision.toString() });
        if (expected.relativePath !== input.descriptor.relativePath) throw new ProcessEvidenceMigrationRefusal("Original Review has a different revision path");
        assertReview(review);
      } else if (key === "activity.evidence") {
        const document = FLOW_ARTIFACT_CONTRACTS.require(key).contentContract.parse(bytes, { processEvidence: this.processEvidence });
        if (document instanceof FlowArtifactSpecReviewActivityEvidenceDocument) {
          const activity = activities.find(entry => entry.id === document.activityId);
          document.assertActivity(activity, { specId: state.specId });
          assertReview(document.review);
        }
      } else if (REVIEW_PROCESS_EVIDENCE_KEYS.includes(key)) {
        const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: key, bytes });
        for (const { attempt } of history.attempts) {
          const record = history.atAttempt(attempt);
          if (record.payload.processStop == null) continue;
          record.publicationPayload();
          reviewStop(record.payload.processStop, record.nodeId, record.attempt);
        }
      } else if (key === "source.handoff.event") {
        const event = SourceHandoffEvent.fromStored(input.jsonDocument(), { processEvidence: this.processEvidence });
        if (event.processStopEvidence !== null && event.processStopEvidence.toArtifactJSON().schemaVersion === 3) {
          sourceEvents.set(event.identity.storageId, event);
        }
      }
    }
    if (sourceEvents.size !== 0) {
      const repositoryIdentity = captureProcessExecutionCheckoutIdentity({ mainRoot: this.location.repositoryRoot });
      for (const event of sourceEvents.values()) {
        const authority = readSourceHandoffAuthorityFromView({ view, identity: event.identity,
          root: event.processStopEvidence.receipt.checkoutIdentity.executionRoot,
          canonicalLocation: this.location, repositoryIdentity });
        if (authority === null || !authority.settled) throw new ProcessEvidenceMigrationRefusal(
          "Previous Source receipt requires its complete settled producer graph");
      }
    }
    return new ProcessEvidenceArtifactProducerGraph(graphToken, this.migrationInputs, this.processEvidence, this.#proofs);
  }
}
