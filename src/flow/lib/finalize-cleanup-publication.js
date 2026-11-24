import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../lib/flow-version.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { DraftStepSettlementReceipt, settleFinalizationStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { CanonicalFlowArtifactWrite, CanonicalTransitionView } from "./current-flow-state.js";
import { artifactPublicationClaimForStep } from "./flow-artifact-authority.js";
import { FinalizeCleanupEffectPreparation, SharedFinalizeCleanupJournal, assertExactObjectKeys } from "./finalize-cleanup-journal.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { FinalizeCleanupResultEvidence } from "../steps/finalize/finalization-values.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { deepFreeze } from "./review-observation-values.js";
import { SourceExecutionObservationAppends, SourceExecutionObservationCatalogBaseline } from "./source-execution-observation-appends.js";

const LOGICAL_KEY = "finalize.cleanup.publication";

/**
 * Completed external effects, not a completed canonical Step. The immutable
 * catalog publication authorizes only the same Result/receipt publication;
 * it never grants permission for another hook, Git command or teardown.
 */
export class FinalizeCleanupCompletionPublication {
  constructor({ version, stepResult, receipt, sourceRevision, sourceCatalog }, sourcePreparation = null) {
    if (version !== 1) throw new TypeError("Cleanup completion publication version is invalid");
    const result = StepResult.fromStored("finalize-cleanup", stepResult);
    const settlement = settleFinalizationStepResult("finalize-cleanup", result);
    DraftStepSettlementReceipt.assertStored(receipt, { result, settlement });
    if (receipt.binding.stepId !== "finalize-cleanup" || settlement.kind !== "completion") {
      throw new TypeError("Cleanup completion publication requires its selected Completion");
    }
    this.stepResult = result;
    this.receipt = deepFreeze(structuredClone(receipt));
    this.evidence = FinalizeCleanupResultEvidence.fromJSON(receipt.finalization.evidence);
    this.evidence.assertResult(result);
    this.publication = this.receipt.finalization.candidate;
    this.sourceRevision = sourceRevision;
    this.sourceCatalog = new FlowArtifactCatalog(sourceCatalog);
    if (this.evidence.execution.journal?.phase !== "pointer-written"
      || typeof this.publication?.selectedActivityId !== "string"
      || !/^[a-f0-9]{64}$/.test(this.publication.revision)
      || !/^[a-f0-9]{64}$/.test(this.publication.catalogFingerprint)
      || !/^[a-f0-9]{64}$/.test(sourceRevision)
      || sourceCatalog.hash !== this.sourceCatalog.hash
      || this.sourceCatalog.hash !== this.publication.catalogFingerprint) {
      throw new TypeError("Cleanup completion publication requires its completed effect and source baseline");
    }
    this.sourcePreparation = sourcePreparation;
    this.resumed = true;
    Object.freeze(this);
  }

  static fromStored(value, sourcePreparation = null) {
    assertExactObjectKeys(value, ["version", "stepResult", "receipt", "sourceRevision", "sourceCatalog"], "cleanup completion publication");
    return new this(value, sourcePreparation);
  }

  toJSON() { return { version: 1, stepResult: this.stepResult.toJSON(), receipt: this.receipt,
    sourceRevision: this.sourceRevision, sourceCatalog: this.sourceCatalog.toJSON() }; }
  toBytes() { return Buffer.from(`${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8"); }
  get journal() { return this.sourcePreparation.journal; }

  /** Remove only this exact, catalog-authenticated publication from its own baseline. */
  retainedCatalog(catalog) {
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(LOGICAL_KEY);
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
    const bytes = this.toBytes();
    const expected = new FlowArtifactDescriptor({ ...artifact.publication({ mediaType: "application/json", updater: "finalize-cleanup" }),
      hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    if (descriptor === undefined || !isDeepStrictEqual(descriptor.toJSON(), expected.toJSON())) {
      throw new CurrentFlowStateConflictError("Cleanup completion publication lost its exact catalog authority");
    }
    return new FlowArtifactCatalog({ artifacts: catalog.artifacts.filter((entry) => entry.relativePath !== artifact.relativePath) });
  }

  assertView(view) {
    const retained = new CanonicalTransitionView({ location: view.location,
      snapshot: { state: view.state, revision: view.revision, activities: view.activities },
      catalog: this.retainedCatalog(view.catalog) });
    const observations = new SourceExecutionObservationAppends(retained,
      new SourceExecutionObservationCatalogBaseline({ catalog: this.sourceCatalog, root: view.location.repositoryRoot }));
    if (retained.sourceEvidenceRevision({ executionObservations: observations }) !== this.sourceRevision) {
      throw new CurrentFlowStateConflictError("Cleanup completion publication source evidence changed");
    }
  }

  assertPublication(stepResult, receipt) {
    const finalization = receipt.finalization.toJSON?.() ?? receipt.finalization;
    const { catalogFingerprint: _oldCatalog, revision: _oldRevision, ...expected } = this.publication;
    const { catalogFingerprint: _currentCatalog, revision: _currentRevision, ...current } = finalization.candidate;
    if (!isDeepStrictEqual(stepResult.toJSON(), this.stepResult.toJSON())
      || !isDeepStrictEqual(finalization.evidence, this.receipt.finalization.evidence)
      || !isDeepStrictEqual(finalization.commandResult, this.receipt.finalization.commandResult)
      || !isDeepStrictEqual(current, expected)) {
      throw new CurrentFlowStateConflictError("Cleanup completion publication changed its selected Result or receipt");
    }
  }

  /** Publish before the process barrier; the normal finalization transaction remains separate. */
  static ensure({ versionStore, stepResult, receipt, candidate }) {
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(LOGICAL_KEY);
    const acquired = versionStore.readCanonicalTransitionView((view) => {
      const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === artifact.relativePath);
      if (descriptor === undefined) return null;
      const checkpoint = this.fromStored(JSON.parse(view.readCatalogedArtifact(descriptor)));
      checkpoint.assertView(view);
      checkpoint.assertPublication(stepResult, receipt.toJSON());
      return checkpoint;
    });
    if (acquired !== null) return acquired;
    const checkpoint = versionStore.readCanonicalTransitionView((view) => {
      candidate.assert(view);
      return new this({ version: 1, stepResult: stepResult.toJSON(), receipt: receipt.toJSON(),
        sourceRevision: view.sourceEvidenceRevision(), sourceCatalog: view.catalog.toJSON() });
    });
    const write = new CanonicalFlowArtifactWrite({ logicalKey: LOGICAL_KEY,
      mediaType: "application/json", bytes: checkpoint.toBytes() });
    versionStore.catalogStore.publish({ ...artifact.publication({ mediaType: write.mediaType, updater: "finalize-cleanup" }),
      publicationClaim: artifactPublicationClaimForStep("finalize-cleanup"),
      precondition: (catalog) => {
        if (catalog.hash !== checkpoint.publication.catalogFingerprint) {
          throw new CurrentFlowStateConflictError("Cleanup completion publication source catalog changed before checkpoint");
        }
      },
      write: () => write.write(versionStore.location),
    });
    return checkpoint;
  }

  static acquire(ctx) {
    try { return this.#acquire(ctx); }
    catch (error) {
      if (error instanceof StepAdmissionRefusal) throw error;
      const refusal = new StepAdmissionRefusal(error.message, error);
      refusal.code = error.code;
      throw refusal;
    }
  }

  static #acquire(ctx) {
    const owner = FinalizeFlowStateOwner.forMainContext(ctx);
    const checkpoint = owner.flowManager.readCanonicalTransitionView({ specId: owner.specId, read: (view) => {
      const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === LOGICAL_KEY);
      if (descriptor === undefined) return null;
      const value = this.fromStored(JSON.parse(view.readCatalogedArtifact(descriptor)));
      value.assertView(view);
      return value;
    } });
    if (checkpoint === null) return null;
    const source = FinalizeCleanupEffectPreparation.acquireSource(ctx);
    if (source === null || !isDeepStrictEqual(source.journal.value, checkpoint.evidence.execution.journal)) {
      throw new StepAdmissionRefusal("Cleanup completion publication lost its exact effect journal");
    }
    const acquired = this.fromStored(checkpoint.toJSON(), source);
    acquired.executionForBinding({ runId: source.identity.runId, specId: source.identity.specId,
      stepId: "finalize-cleanup", attempt: source.identity.attempt });
    return acquired;
  }

  executionForBinding(binding) {
    const execution = this.evidence.execution;
    const acquired = this.sourcePreparation.executionForBinding(binding);
    if (!isDeepStrictEqual(acquired.toJSON(), execution.toJSON())) {
      throw new StepAdmissionRefusal("Cleanup completion publication belongs to another source Attempt");
    }
    return execution;
  }

  assertCurrent(ctx) {
    this.sourcePreparation.assertSourceCurrent(ctx);
    const owner = this.sourcePreparation.owner;
    owner.flowManager.readCanonicalTransitionView({ specId: owner.specId, read: (view) => this.assertView(view) });
    return this;
  }

  prepare(ctx, prepareFinalizationExecution) {
    this.assertCurrent(ctx);
    const commandResult = new Envelope(structuredClone(this.receipt.finalization.commandResult));
    const preparation = prepareFinalizationExecution({ ctx: { ...ctx, finalizationJournal: this.evidence.execution.journal },
      stepId: "finalize-cleanup", commandResult, execution: this.evidence.execution,
      selectedActivityId: this.publication.selectedActivityId, completionPublication: this });
    const receipt = { finalization: { evidence: preparation.evidence.toJSON(), commandResult: commandResult.toJSON(),
      candidate: preparation.finalizationPublication.toJSON() } };
    this.assertPublication(this.stepResult, receipt);
    return preparation;
  }

  completeJournal(ctx) {
    const owner = FinalizeFlowStateOwner.forMainContext(ctx);
    SharedFinalizeCleanupJournal.open(owner.loadReadOnly()).advance("completed");
  }
}
