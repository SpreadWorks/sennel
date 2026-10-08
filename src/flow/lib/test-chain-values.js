import {
  NonGateTargetBinding, NonGateProducerOwnership, NonGateCatalogPublication,
  NonGateSourcePublication, NonGateLineage, NonGateRetryMetrics, NonGateCompletionFacts,
} from "./non-gate-transition.js";
import { AuthenticatedTestExecutionCompletion, TestExecuteStepFacts, TestResultReviewStepFacts } from "./test-chain-observation-values.js";
import { AcceptedNonblockingDecision } from "./accepted-nonblocking-decision.js";

export class TestChainMeaning {
  constructor({ stepId, value, reason = null }) {
    const kinds = stepId === "test-execute"
      ? { execution: "test-execute-execution-required", observed: "test-execute-observed", error: "test-execute-error" }
      : stepId === "test-result-review"
        ? { accepted: "test-result-review-evidence-accepted", rejected: "test-result-review-evidence-rejected", error: "test-result-review-error" } : {};
    if (!Object.hasOwn(kinds, value)) throw new TypeError("Unknown test-chain meaning");
    this.value = value;
    this.reason = reason;
    this.resultKind = kinds[value];
    Object.freeze(this);
  }
}

/** Observation semantics shared with the existing non-Gate transition policy. */
export function testChainObservationMeaning(observation) {
  const stepId = observation instanceof TestExecuteStepFacts ? "test-execute"
    : observation instanceof TestResultReviewStepFacts ? "test-result-review" : null;
  if (stepId === null) throw new TypeError("Test-chain meaning requires a typed observation");
  return new TestChainMeaning({ stepId,
    value: observation.toolingFailure ? "error" : stepId === "test-execute" ? "observed"
      : observation.verdict === "fail" ? "rejected" : "accepted",
    reason: observation.toolingFailure ? "TEST_CHAIN_TOOLING_FAILURE" : null });
}

function classifyTestChainEvidence(evidence) {
  const meaning = (value, reason = null) => new TestChainMeaning({ stepId: evidence.stepId, value, reason });
  if (evidence.integrityFailure !== null) return meaning("error", evidence.integrityFailure);
  if (evidence.executionRequired) return evidence.stepId === "test-execute"
    ? meaning("execution") : meaning("error", "TEST_CHAIN_TOOLING_FAILURE");
  if (evidence.completion.partial) return meaning("error", evidence.completion.refusalReason);
  const observed = testChainObservationMeaning(evidence.observation);
  if (["error", "rejected"].includes(observed.value)) return observed;
  if (evidence.completion.refusalReason !== null) return meaning("error", evidence.completion.refusalReason);
  return observed;
}

/** Acquired immutable evidence for one test-chain Attempt. */
export class TestChainResultEvidence {
  #meaning;
  constructor({ identity, observation = null, producer = null, publication = null,
    source = null, lineage = null, retry, completion = null, integrityFailure = null, snapshotRevision = null, acceptedDecision = null } = {}) {
    if (!(identity instanceof NonGateTargetBinding)
      || !["test-execute", "test-result-review"].includes(identity.stepId)
      || !(retry instanceof NonGateRetryMetrics)
      || completion !== null && !(completion instanceof NonGateCompletionFacts)
      || observation !== null && !(observation instanceof (identity.stepId === "test-execute" ? TestExecuteStepFacts : TestResultReviewStepFacts))
      || producer !== null && !(producer instanceof NonGateProducerOwnership)
      || publication !== null && !(publication instanceof NonGateCatalogPublication)
      || source !== null && !(source instanceof NonGateSourcePublication)
      || lineage !== null && !(lineage instanceof NonGateLineage)
      || integrityFailure !== null && (typeof integrityFailure !== "string" || integrityFailure === "")) {
      throw new TypeError("Test chain Result requires typed identity, observation, and retry evidence");
    }
    if (producer !== null && (producer.runId !== identity.runId || producer.specId !== identity.specId
      || producer.stepId !== identity.stepId || !producer.attempt.matches(identity.attempt))) {
      throw new TypeError("Test chain producer does not own its Result Attempt");
    }
    if (publication !== null && (producer === null || publication.producerActivityId !== producer.activityId
      || !publication.attempt.matches(identity.attempt))) throw new TypeError("Test chain publication does not match its producer");
    if (observation !== null && (producer === null || publication === null || source === null || lineage === null)) {
      throw new TypeError("Test chain observation requires its exact producer publication and source lineage");
    }
    if (publication !== null && (typeof snapshotRevision !== "string" || snapshotRevision === "")) {
      throw new TypeError("Test chain publication requires its acquired snapshot revision");
    }
    if (publication === null && snapshotRevision !== null) {
      throw new TypeError("An unpublished test-chain request cannot carry a publication snapshot");
    }
    if (observation === null && integrityFailure === null
      && (producer !== null || publication !== null || source !== null || lineage !== null)) {
      throw new TypeError("Test-chain publication requires an acquired observation or integrity failure");
    }
    if (observation instanceof TestResultReviewStepFacts && observation.executionCompletion !== null
      && !observation.executionCompletion.matches(source, observation.value("rawEvidenceFingerprint"))) {
      throw new TypeError("Test Review completion does not match its execution source");
    }
    this.identity = identity;
    this.observation = observation;
    this.producer = producer;
    this.publication = publication;
    this.source = source;
    this.lineage = lineage;
    this.retry = retry;
    this.snapshotRevision = snapshotRevision;
    this.completion = completion ?? new NonGateCompletionFacts(observation === null ? {}
      : observation.rawAvailable || observation instanceof TestResultReviewStepFacts && observation.executionCompletion !== null
        ? { completed: true } : { partial: true });
    if (observation !== null && this.completion.completed && !observation.rawAvailable
      && !(observation instanceof TestResultReviewStepFacts && observation.executionCompletion?.matches(source, observation.value("rawEvidenceFingerprint")))) {
      throw new TypeError("Completed test-chain evidence requires its raw observation or authenticated execution completion");
    }
    this.integrityFailure = integrityFailure;
    this.#meaning = classifyTestChainEvidence(this);
    if (acceptedDecision !== null) {
      if (!(acceptedDecision instanceof AcceptedNonblockingDecision) || this.stepId !== "test-result-review"
        || integrityFailure !== null || this.executionRequired || this.completion.partial
        || this.#meaning.value !== "rejected" || !retry.exhausted) {
        throw new TypeError("Accepted test evidence requires its actual exhausted rejection");
      }
      acceptedDecision.assertEvidence(this);
    }
    this.acceptedDecision = acceptedDecision;
    Object.freeze(this);
  }

  get stepId() { return this.identity.stepId; }
  get executionRequired() { return this.observation === null && this.integrityFailure === null; }
  get meaning() { return this.#meaning; }
  get resultKind() { return this.#meaning.resultKind; }
  assertResultKind(kind) {
    if (kind !== this.resultKind) throw new TypeError("Test-chain Result kind contradicts its acquired evidence");
  }

  toJSON() {
    return { identity: this.identity.toJSON(), observation: this.observation?.toJSON() ?? null,
      producer: this.producer?.toJSON() ?? null, publication: this.publication?.toJSON() ?? null,
      source: this.source?.toJSON() ?? null, lineage: this.lineage?.toJSON() ?? null,
      retry: this.retry.toJSON(), completion: this.completion.toJSON(), integrityFailure: this.integrityFailure,
      ...(this.snapshotRevision === null ? {} : { snapshotRevision: this.snapshotRevision }),
      ...(this.acceptedDecision === null ? {} : { acceptedDecision: this.acceptedDecision.toJSON() }) };
  }

  static fromJSON(value) {
    const identity = new NonGateTargetBinding(value.identity);
    const Observation = identity.stepId === "test-execute" ? TestExecuteStepFacts : TestResultReviewStepFacts;
    return new TestChainResultEvidence({ identity,
      observation: value.observation === null ? null : new Observation({ ...value.observation.values,
        ...(value.observation.values.executionCompletion === undefined ? {} : { executionCompletion:
          AuthenticatedTestExecutionCompletion.fromJSON(value.observation.values.executionCompletion) }) }),
      producer: value.producer === null ? null : new NonGateProducerOwnership(value.producer),
      publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication),
      source: value.source === null ? null : new NonGateSourcePublication(value.source),
      lineage: value.lineage === null ? null : new NonGateLineage(value.lineage),
      retry: new NonGateRetryMetrics(value.retry), completion: new NonGateCompletionFacts(value.completion), integrityFailure: value.integrityFailure,
      snapshotRevision: value.snapshotRevision ?? null,
      acceptedDecision: value.acceptedDecision === undefined ? null : AcceptedNonblockingDecision.fromJSON(value.acceptedDecision) });
  }

  static fromResult(result) {
    if (result?.stepId !== "test-result-review") return null;
    return result.evidence instanceof TestChainResultEvidence ? result.evidence
      : result.error?.data?.evidence == null ? null : TestChainResultEvidence.fromJSON(result.error.data.evidence);
  }

  static fromTransitionFacts(facts) {
    return new TestChainResultEvidence({ identity: facts.target,
      observation: facts.stepFacts instanceof TestExecuteStepFacts || facts.stepFacts instanceof TestResultReviewStepFacts
        ? facts.stepFacts : null,
      producer: facts.producer, publication: facts.catalogPublication, source: facts.sourcePublication,
      lineage: facts.lineage, retry: facts.retry, completion: facts.completion, integrityFailure: facts.integrityFailure,
      snapshotRevision: facts.snapshotRevision });
  }
}
