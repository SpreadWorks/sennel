/**
 * Canonical, read-only Gate transition facts.
 *
 * This is deliberately the one place that translates a Version-1 Attempt,
 * catalog publication, and gate result history into the input accepted by
 * definition.js.  Commands must not reconstruct any of these identities
 * from their invocation arguments or process-local state.
 */
import {
  GateFailureCategory,
  GateTaskBudget,
  GateTaskLifecycle,
  GateTransitionFacts,
  TaskGateClassificationRecoveryProgress,
  TaskGateSettlementProgress,
} from "./gate-transition.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import {
  canonicalGateNodeId,
  taskGateSettlementIssueLogActivityId,
  canonicalGateRevision,
  taskGateSettlementIssueLogId,
  taskGateSettlementMetricActivityId,
} from "./canonical-gate-artifacts.js";
import { inspectCanonicalPlanGateRepair } from "./plan-gate-repair.js";
import { evaluateReviewFindingGateReadiness } from "./review-finding-gate-readiness.js";
import { captureCurrentTaskSource } from "./task-mutation-lineage.js";
import {
  TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION,
  TaskGateClassificationRecoveryIdentity,
} from "./task-gate-classification-recovery.js";

const SHA256 = /^[a-f0-9]{64}$/;

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function gateKeys(phase, taskId) {
  if (phase === "draft") return { result: "draft.gate", source: "draft.gate.source", parameters: {} };
  if (phase === "spec" || phase === "task-spec") return { result: "spec.gate", source: "spec.gate.source", parameters: {} };
  if (phase === "task-impl" && taskId !== null) {
    return { result: "task.gate", source: "task.gate.source", parameters: { taskId } };
  }
  return { result: "impl.gate", source: "impl.gate.source", parameters: {} };
}

function scopeFor(phase, taskId) {
  return phase === "task-impl" && taskId !== null ? "task" : "flow";
}

function taskLifecycleFor(state, taskId) {
  if (taskId === null) return null;
  const container = state.findNode(state.definition.dynamicTaskContainerId);
  const tasks = container?.steps.filter((node) => node.kind === "task") ?? [];
  const index = tasks.findIndex((task) => task.id === taskId);
  const task = index < 0 ? null : tasks[index];
  if (task === null) throw new Error("canonical Task Gate lifecycle Task is absent");
  const expected = ["impl", "review", "triage", "repair", "gate"].map((role) => `${taskId}-${role}`);
  if (!Array.isArray(task.steps) || task.steps.length !== expected.length
    || task.steps.some((step, position) => step.id !== expected[position])) {
    throw new Error("canonical Task Gate lifecycle materialized Task Step identity is invalid");
  }
  const nextTask = tasks.slice(index + 1).find((candidate) => (
    candidate.status === "pending" || candidate.status === "invalidated"
  )) ?? null;
  const leaves = state.definition.orderedLeaves(state.root);
  const gateIndex = leaves.findIndex((leaf) => leaf.id === expected[4]);
  const successor = gateIndex < 0 ? null : leaves.slice(gateIndex + 1)
    .find((leaf) => leaf.status === "pending" || leaf.status === "invalidated") ?? null;
  if (successor === null) throw new Error("canonical Task Gate lifecycle has no executable successor");
  const finalGateId = `${tasks.at(-1).id}-gate`;
  const finalGateIndex = leaves.findIndex((leaf) => leaf.id === finalGateId);
  const integration = finalGateIndex < 0 ? null : leaves.slice(finalGateIndex + 1)
    .find((leaf) => leaf.status === "pending" || leaf.status === "invalidated") ?? null;
  if (integration === null) throw new Error("canonical Task Gate lifecycle has no integration successor");
  if (nextTask !== null && successor.id !== `${nextTask.id}-impl`) {
    throw new Error("canonical Task Gate lifecycle next Task does not own its successor");
  }
  if (nextTask === null && successor.id !== integration.id) {
    throw new Error("canonical final Task Gate lifecycle does not own the integration successor");
  }
  return new GateTaskLifecycle({
    taskId,
    implStepId: expected[0],
    reviewStepId: expected[1],
    triageStepId: expected[2],
    repairStepId: expected[3],
    gateStepId: expected[4],
    nextTaskId: nextTask?.id ?? null,
    integrationStepId: integration.id,
  });
}

function optionalConsumerDocument({ flowManager, state, logicalKey, activities }) {
  const source = flowManager.readArtifact({
    specId: state.specId, logicalKey, consumerNodeId: "impl-gate", optional: true,
  });
  if (source === null) return null;
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`canonical ${logicalKey} artifact must be JSON: ${error.message}`);
  }
  const activity = source.descriptor.activityId === null
    ? null
    : activities.find((entry) => entry.id === source.descriptor.activityId) ?? null;
  if (activity === null) throw new Error(`canonical ${logicalKey} artifact lacks its catalog Activity lineage`);
  return Object.freeze({ value, fingerprint: source.descriptor.hash, activity });
}

function reviewFindingMap(artifacts) {
  const entries = new Map();
  for (const artifact of artifacts) {
    for (const finding of artifact.blockingFindings || []) {
      if (typeof finding?.findingKey === "string" && typeof finding?.findingId === "string") {
        entries.set(finding.findingKey, finding.findingId);
      }
    }
  }
  return entries;
}

function sameMembers(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Read review, triage and repair lineage once, before Definition classifies integration. */
function integrationReviewReadiness({ flowManager, state }) {
  const activities = flowManager.activityLedger(state.specId);
  const reviewSource = flowManager.readArtifact({
    specId: state.specId, logicalKey: "impl.review", consumerNodeId: "impl-gate", optional: true,
  });
  if (reviewSource === null) throw new Error("integration Gate requires canonical impl.review evidence");
  const reviewActivity = reviewSource.descriptor.activityId === null
    ? null
    : activities.find((entry) => entry.id === reviewSource.descriptor.activityId) ?? null;
  if (reviewActivity === null || reviewActivity.nodeId !== "impl-review") {
    throw new Error("integration Gate review artifact lacks canonical impl-review publication lineage");
  }
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: "impl.review", bytes: reviewSource.bytes,
  });
  const reviewArtifacts = history.attempts.map((entry) => entry.payload);
  const currentFindings = reviewFindingMap([history.current.payload]);
  const historicalFindings = reviewFindingMap(reviewArtifacts);
  const triage = optionalConsumerDocument({ flowManager, state, logicalKey: "impl.triage", activities });
  const repair = optionalConsumerDocument({ flowManager, state, logicalKey: "impl.repair", activities });
  const triageCurrent = triage !== null && triage.activity.nodeId === "impl-triage"
    && triage.activity.confirmationOrder > reviewActivity.confirmationOrder;
  const dispositions = triage?.value?.dispositions || [];
  if (!Array.isArray(dispositions)) throw new Error("canonical impl.triage dispositions must be an array");
  const staleTriageKeys = dispositions.map((entry) => entry?.findingKey)
    .filter((key) => typeof key === "string" && currentFindings.has(key));
  if (!triageCurrent && staleTriageKeys.length > 0) {
    throw new Error("canonical impl.triage lineage is stale for the current review finding identity");
  }
  const triageItems = triageCurrent
    ? dispositions.filter((entry) => entry?.disposition === "reject" && currentFindings.has(entry.findingKey))
      .map((entry) => ({ findingId: currentFindings.get(entry.findingKey), decision: "reject" }))
    : [];
  const applied = new Set(triageCurrent
    ? dispositions.filter((entry) => entry?.disposition === "apply" && currentFindings.has(entry.findingKey))
      .map((entry) => entry.findingKey)
    : []);
  const repairCurrent = repair !== null && triageCurrent
    && repair.activity.nodeId === "impl-repair"
    && repair.activity.confirmationOrder > triage.activity.confirmationOrder;
  const repairHistorical = repair !== null && triage !== null && currentFindings.size === 0
    && triage.activity.nodeId === "impl-triage"
    && repair.activity.nodeId === "impl-repair"
    && triage.activity.confirmationOrder < repair.activity.confirmationOrder
    && repair.activity.confirmationOrder < reviewActivity.confirmationOrder;
  const repaired = new Set(repair?.value?.appliedFindingKeys || []);
  if (repair !== null && !Array.isArray(repair?.value?.appliedFindingKeys)) {
    throw new Error("canonical impl.repair applied finding keys must be an array");
  }
  const historicalApplied = new Set((triage?.value?.dispositions || [])
    .filter((entry) => entry?.disposition === "apply")
    .map((entry) => entry.findingKey));
  if ((repairCurrent && !sameMembers(applied, repaired))
    || (repairHistorical && !sameMembers(historicalApplied, repaired))) {
    throw new Error("canonical impl.repair findings must exactly match the preceding impl.triage apply set");
  }
  const resolvedFindingIds = (repairCurrent || repairHistorical)
    ? [...repaired].map((key) => currentFindings.get(key) ?? historicalFindings.get(key)).filter(Boolean)
    : [];
  return evaluateReviewFindingGateReadiness({
    reviewArtifacts,
    phase: "integration",
    runId: state.runId,
    triage: { items: triageItems },
    repairLedger: null,
    reviewFingerprints: history.attempts.map((entry) => `${reviewSource.descriptor.hash}:${entry.attempt}`),
    triageFingerprint: triage?.fingerprint ?? null,
    repairFingerprint: repair?.fingerprint ?? null,
    resolvedFindingIds,
    // impl.review attempts are ordered canonical publications. A changed
    // repair fingerprint is the authoritative current-review boundary; an
    // unchanged fingerprint deliberately retains prior unresolved findings.
    supersedesHistory: true,
  }).toJSON();
}

class GateFailureResolution {
  constructor({ failure = null, classificationMismatch = false } = {}) {
    if (failure !== null && !(failure instanceof GateFailureCategory)) {
      throw new Error("Gate failure resolution requires a typed failure");
    }
    if (typeof classificationMismatch !== "boolean") {
      throw new Error("Gate failure resolution mismatch flag must be boolean");
    }
    if (classificationMismatch && failure === null) {
      throw new Error("Gate failure resolution mismatch requires an authoritative failure");
    }
    this.failure = failure;
    this.classificationMismatch = classificationMismatch;
    Object.freeze(this);
  }
}

function resultFailure(payload, attempt, { taskScope = false } = {}) {
  if (payload?.result !== "fail") return new GateFailureResolution();
  const artifactCategory = payload?.artifacts?.gateTransitionFailureCategory ?? null;
  const attemptCategory = attempt?.failure === null || attempt?.failure === undefined
    ? null
    : { category: attempt.failure.category, code: attempt.failure.code };
  // A Gate observation and its active Attempt are one canonical failure
  // record. During post-publication admission the result supplies the fact;
  // after failure recording the Attempt supplies the same fact. If both are
  // present they must agree, so an old or rewritten artifact cannot change a
  // semantic decision.
  if (artifactCategory === null && attemptCategory === null) {
    throw new Error("canonical failed Gate observation has no failure classification");
  }
  const artifact = artifactCategory === null ? null : new GateFailureCategory(artifactCategory);
  const attemptFailure = attemptCategory === null ? null : new GateFailureCategory(attemptCategory);
  const classificationMismatch = artifact !== null && attemptFailure !== null
    && (artifact.category !== attemptFailure.category || artifact.code !== attemptFailure.code);
  if (classificationMismatch && !taskScope) {
    throw new Error("canonical Gate result and current Attempt failure classification disagree");
  }
  return new GateFailureResolution({
    failure: artifact ?? attemptFailure,
    classificationMismatch,
  });
}

function currentGateActivity({ activities, nodeId, attempt }) {
  const matches = activities.filter((activity) => (
    activity.nodeId === nodeId
    && activity.attemptId === attempt.id
    && activity.sequence === attempt.sequence
  ));
  // Publication's activity is canonical proof of the exact producer. An
  // Attempt may have a start Activity too, so select the catalog-associated
  // activity below rather than relying on chronology.
  return matches;
}

function sameFailure(left, right) {
  return left?.category === right?.category && left?.code === right?.code;
}

class TaskGateClassificationRecoveryObservation {
  constructor({ progress, classifications }) {
    if (!(progress instanceof TaskGateClassificationRecoveryProgress)) {
      throw new Error("Task Gate classification recovery observation requires typed progress");
    }
    if (!Array.isArray(classifications)) {
      throw new Error("Task Gate classification recovery observation requires classification Activities");
    }
    this.progress = progress;
    this.classifications = Object.freeze([...classifications]);
    Object.freeze(this);
  }
}

function taskGateClassificationRecovery({ attempt, publication, producerActivities, failure, classificationMismatch }) {
  const failures = producerActivities.filter((activity) => (
    activity.transition?.operation === "fail_attempt"
    && activity.confirmationOrder >= publication.confirmationOrder
  ));
  const recoveries = producerActivities.filter((activity) => (
    activity.transition?.operation === TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION
  ));
  if (recoveries.length > 1) {
    throw new Error("Task Gate settlement has duplicate classification recovery effects");
  }
  const recovery = recoveries[0] ?? null;
  if (recovery === null) {
    if (!classificationMismatch) {
      return new TaskGateClassificationRecoveryObservation({
        progress: new TaskGateClassificationRecoveryProgress(),
        classifications: failures,
      });
    }
    if (attempt.failure?.category !== "tooling" || failures.length !== 1
      || failures[0].confirmationOrder <= publication.confirmationOrder
      || !sameFailure(failures[0].failure, attempt.failure)) {
      throw new Error("canonical Gate result and current Attempt failure classification disagree");
    }
    return new TaskGateClassificationRecoveryObservation({
      progress: new TaskGateClassificationRecoveryProgress({
        status: "required",
        failedActivityId: failures[0].id,
      }),
      classifications: [],
    });
  }
  const superseded = failures.filter((activity) => activity.confirmationOrder < recovery.confirmationOrder);
  if (superseded.length !== 1 || superseded[0].failure?.category !== "tooling"
    || superseded[0].confirmationOrder <= publication.confirmationOrder
    || sameFailure(superseded[0].failure, failure)) {
    throw new Error("Task Gate classification recovery does not identify one conflicting tooling failure");
  }
  const identity = new TaskGateClassificationRecoveryIdentity({
    publicationActivityId: publication.id,
    failedActivityId: superseded[0].id,
    attempt,
  });
  if (recovery.id !== identity.activityId
    || recovery.attemptId !== attempt.id
    || recovery.sequence !== attempt.sequence
    || recovery.transition?.attempt?.id !== attempt.id
    || recovery.transition?.attempt?.sequence !== attempt.sequence
    || recovery.transition?.attempt?.failure !== null) {
    throw new Error("Task Gate classification recovery is not bound to its canonical Attempt history");
  }
  return new TaskGateClassificationRecoveryObservation({
    progress: new TaskGateClassificationRecoveryProgress({
      status: "recorded",
      failedActivityId: superseded[0].id,
      recoveryActivityId: recovery.id,
    }),
    classifications: failures.filter((activity) => activity.confirmationOrder > recovery.confirmationOrder),
  });
}

function taskGateSettlementProgress({ flowManager, state, nodeId, taskId, attempt, publication, catalogFingerprint, lineage, activities, producerActivities, failure, classificationRecorded, classificationMismatch }) {
  const orderedActivities = activities.map((activity) => {
    if (!Number.isSafeInteger(activity.confirmationOrder)) {
      throw new Error("Task Gate settlement Activity ordering is unavailable");
    }
    return activity;
  });
  let classificationOrder = publication.confirmationOrder;
  let classificationRecovery = new TaskGateClassificationRecoveryProgress();
  if (failure !== null) {
    const recovery = taskGateClassificationRecovery({
      attempt, publication, producerActivities, failure, classificationMismatch,
    });
    const classifications = recovery.classifications;
    if (classifications.length > 1) {
      throw new Error("Task Gate settlement has duplicate semantic classification effects");
    }
    const classification = classifications[0] ?? null;
    if (classificationRecorded !== (classification !== null)) {
      throw new Error("Task Gate settlement classification evidence is inconsistent");
    }
    if (classification !== null && (classification.failure?.category !== failure.category
      || classification.failure?.code !== failure.code)) {
      throw new Error("Task Gate settlement classification does not match its canonical result");
    }
    classificationOrder = classification?.confirmationOrder ?? null;
    classificationRecovery = recovery.progress;
  }
  const metricOperations = ["increment", "reset"].filter((operation) => {
    const id = taskGateSettlementMetricActivityId({
      publicationActivityId: publication.id, nodeId, attempt, operation,
    });
    const matching = orderedActivities.filter((candidate) => candidate.id === id);
    if (matching.length > 1) throw new Error("Task Gate settlement has duplicate metric Activities");
    const activity = matching[0] ?? null;
    if (activity === null) return false;
    if (activity.confirmationOrder <= publication.confirmationOrder
      || (classificationOrder !== null && activity.confirmationOrder <= classificationOrder)) {
      throw new Error("Task Gate settlement metric Activity was recorded before its prerequisite");
    }
    if (activity.transition?.operation !== "record_metric"
      || activity.nodeId !== taskId
      || activity.metric?.phase !== "task-impl"
      || activity.metric?.counter !== "gateRetry"
      || (activity.metric.reset === true ? "reset" : "increment") !== operation) {
      throw new Error("Task Gate settlement metric Activity does not match its stable identity");
    }
    return true;
  });
  if (new Set(metricOperations).size !== metricOperations.length) {
    throw new Error("Task Gate settlement has duplicate metric effects");
  }
  const issueLog = flowManager.readArtifact({
    specId: state.specId, logicalKey: "issue.log", consumerNodeId: nodeId, optional: true,
  });
  let issueLogRecorded = false;
  if (issueLog !== null) {
    const document = JSON.parse(issueLog.bytes.toString("utf8"));
    const issueLogId = taskGateSettlementIssueLogId({
      runId: state.runId, nodeId, attempt: state.attempt,
      publicationActivityId: publication.id, catalogFingerprint,
    });
    const matching = (document?.entries || []).filter((entry) => (
      entry?.issueLogId === issueLogId
    ));
    if (matching.length > 1) throw new Error("Task Gate settlement has duplicate issue-log effects");
    if (matching.length === 1) {
      const entry = matching[0];
      const matchingActivities = orderedActivities.filter((candidate) => candidate.id === taskGateSettlementIssueLogActivityId({ issueLogId }));
      if (matchingActivities.length !== 1) {
        throw new Error("Task Gate settlement issue-log Activity is unavailable");
      }
      const activity = matchingActivities[0];
      const metricOrders = metricOperations.map((operation) => (
        orderedActivities.find((candidate) => candidate.id === taskGateSettlementMetricActivityId({
          publicationActivityId: publication.id, nodeId, attempt, operation,
        }))?.confirmationOrder
      ));
      if (activity.transition?.operation !== "publish_artifacts"
        || activity.nodeId !== nodeId
        || activity.attemptId !== attempt.id
        || activity.sequence !== attempt.sequence
        || activity.confirmationOrder <= publication.confirmationOrder
        || (classificationOrder !== null && activity.confirmationOrder <= classificationOrder)
        || metricOrders.some((order) => order === undefined || activity.confirmationOrder <= order)
        || entry?.taskId !== taskId
        || entry?.step !== nodeId
        || entry?.gateReceipt?.attempt?.id !== attempt.id
        || entry?.gateReceipt?.attempt?.sequence !== attempt.sequence
        || entry?.gateReceipt?.catalogFingerprint !== catalogFingerprint
        || JSON.stringify(entry?.gateReceipt?.lineage) !== JSON.stringify(lineage)) {
        throw new Error("Task Gate settlement issue-log effect is out of order or not bound to its canonical result");
      }
    }
    issueLogRecorded = matching.length === 1;
  }
  return new TaskGateSettlementProgress({
    classificationRecorded,
    classificationRecovery,
    metricOperations,
    issueLogRecorded,
    terminalLifecycleRecorded: false,
  });
}

/**
 * Return null when the current Gate Attempt has not published a result yet.
 * All malformed, stale, or mismatched evidence throws: callers must reject
 * rather than turn an unavailable publication into a guessed transition.
 */
export function readCurrentGateTransitionFacts({ flowManager, flowState, phase, root = null } = {}) {
  if (!flowManager || typeof flowManager.canonicalState !== "function"
    || typeof flowManager.loadReadOnly !== "function"
    || typeof flowManager.readProducerArtifact !== "function"
    || typeof flowManager.readArtifact !== "function"
    || typeof flowManager.activityLedger !== "function") {
    throw new Error("canonical Gate transition facts require FlowManager catalog APIs");
  }
  const specId = required(flowState?.specId, "gate Flow specId");
  const currentView = flowManager.loadReadOnly(specId);
  const taskId = currentView.currentTaskId ?? null;
  const snapshot = taskId === null ? null : flowManager.readCanonicalTransitionSnapshot?.(specId) ?? null;
  if (taskId !== null && snapshot === null) {
    throw new Error("Task Gate transition facts require a canonical transition snapshot");
  }
  const state = taskId === null
    ? flowManager.canonicalState(specId)
    : snapshot?.state ?? null;
  if (state === null || state.current === null || state.attempt === null) return null;
  if (currentView?.runId !== state.runId || currentView?.specId !== state.specId) {
    throw new Error("canonical Gate projected state does not match its persisted identity");
  }
  const nodeId = canonicalGateNodeId({ phase: required(phase, "gate phase"), taskId });
  if (state.current.at(-1) !== nodeId || state.attempt.nodeId !== nodeId) return null;
  const attempt = state.attempt;
  const keys = gateKeys(phase, taskId);
  const resultSource = flowManager.readProducerArtifact({
    specId: state.specId, nodeId, logicalKey: keys.result, parameters: keys.parameters, optional: true,
  });
  if (resultSource === null) return null;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: keys.result, bytes: resultSource.bytes });
  if (history.current.attempt < attempt.sequence) return null;
  if (history.current.attempt !== attempt.sequence) {
    throw new Error("gate result history does not belong to the current Attempt sequence");
  }
  const payload = history.current.payload;
  if (payload?.result !== "pass" && payload?.result !== "fail" && payload?.result !== "recovered") {
    throw new Error("canonical Gate result is invalid");
  }
  const persistedPhase = required(payload?.artifacts?.phase, "canonical Gate result phase");
  if (canonicalGateNodeId({ phase: persistedPhase, taskId }) !== nodeId) {
    throw new Error("canonical Gate result phase does not own the active gate node");
  }
  const resultRevision = payload?.artifacts?.gateTransitionLineage;
  const requiresTransitionBinding = taskId !== null || persistedPhase === "integration";
  if (requiresTransitionBinding) {
    if (taskId !== null && payload?.artifacts?.taskId !== taskId) {
      throw new Error("canonical Task Gate result Task binding does not match the active Task");
    }
    if (payload?.artifacts?.gateTransitionAttemptId !== attempt.id
      || payload?.artifacts?.gateTransitionAttemptSequence !== attempt.sequence) {
      throw new Error("canonical Gate result Attempt binding does not match the active Attempt");
    }
    if (typeof resultRevision !== "string" || resultRevision !== canonicalGateRevision(state, nodeId)) {
      throw new Error("canonical Gate result lineage binding is invalid");
    }
    if (taskId !== null) {
      const persistedSourceFingerprint = payload?.artifacts?.sourceFingerprint;
      if (typeof persistedSourceFingerprint !== "string" || !SHA256.test(persistedSourceFingerprint)) {
        throw new Error("canonical Task Gate result source fingerprint is invalid");
      }
      const currentSource = captureCurrentTaskSource({
        root: root ?? flowManager.executionRoot?.(),
        flowManager,
        state: currentView,
        taskId,
      });
      if (currentSource.fingerprint !== persistedSourceFingerprint) {
        throw new Error("canonical Task Gate result source fingerprint is stale; reload the current Task source");
      }
    }
  }
  const activities = flowManager.activityLedger(state.specId);
  const producerActivities = currentGateActivity({ activities, nodeId, attempt });
  const publication = producerActivities.find((activity) => activity.id === resultSource.descriptor.activityId) ?? null;
  if (publication === null) throw new Error("gate catalog publication is not owned by the current Attempt");
  if (publication.transition?.operation !== "publish_artifacts"
    && publication.transition?.operation !== "fail_attempt"
    && publication.transition?.operation !== "confirm_attempt") {
    throw new Error("gate catalog publication has an invalid producer Activity");
  }
  const failureResolution = resultFailure(payload, attempt, { taskScope: taskId !== null });
  const failure = failureResolution.failure;
  // Result publication is intentionally separate from the post hook that
  // records a failed Attempt or advances a passing one.  The canonical
  // Attempt is the only durable marker for a failed result having crossed
  // that classification boundary; pass and recovered results remain
  // unclassified while their producer Attempt is still current.
  const classificationRecorded = payload.result !== "fail"
    || (attempt.failure !== null && !failureResolution.classificationMismatch);
  const postPublication = {
    status: payload.result === "fail" && classificationRecorded ? "classified" : "unclassified",
  };
  let sourceFingerprint = resultSource.descriptor.hash;
  let sourceRevisionFingerprint = null;
  let canonicalRevisionFingerprint = null;
  if (failure?.category === "semantic") {
    const source = flowManager.readProducerArtifact({
      specId: state.specId, nodeId, logicalKey: keys.source, parameters: keys.parameters, optional: true,
    });
    if (source === null && (taskId !== null || persistedPhase === "integration")) {
      throw new Error("canonical semantic Gate failure requires source evidence");
    }
    if (source !== null) {
    const sourceActivity = producerActivities.find((activity) => activity.id === source.descriptor.activityId) ?? null;
    if (sourceActivity === null) throw new Error("gate source publication is not owned by the current Attempt");
    const sourcePayload = JSON.parse(source.bytes.toString("utf8"));
    if (sourcePayload?.phase !== persistedPhase || sourcePayload?.result !== "fail") {
      throw new Error("gate source artifact does not match the canonical Gate result");
    }
    if (taskId !== null && sourcePayload?.taskId !== taskId) {
      throw new Error("Task Gate source artifact Task binding does not match the active Task");
    }
    if (JSON.stringify(sourcePayload.failureCategory) !== JSON.stringify(failure)) {
      throw new Error("gate source failure category does not match the canonical Gate result");
    }
    if (typeof resultRevision !== "string" || resultRevision.length !== 64
      || sourcePayload?.lineage !== resultRevision) {
      throw new Error("gate source and canonical result lineage binding is unavailable or mismatched");
    }
    sourceFingerprint = source.descriptor.hash;
    sourceRevisionFingerprint = sourcePayload.lineage;
    canonicalRevisionFingerprint = resultRevision;
    }
  }
  const contract = state.definition.contractForNode(state.findNode(nodeId));
  const failureCategory = failure?.category ?? "semantic";
  // Consumption is persisted on the Attempt that is being evaluated.  It
  // counts retries that have already started; the failed observation itself
  // must not be added a second time here.  Thus a limit of four permits the
  // initial evaluation plus four replacement Attempts, and the fifth failed
  // evaluation (consumption=4) is the one that settles.
  const used = failureCategory === "semantic"
    ? attempt.consumption.semantic
    : attempt.consumption.tooling;
  const maximum = failureCategory === "semantic"
    ? contract.semanticRetryLimit
    : (contract.toolingRetryLimit ?? 0);
  // GateRetryMetrics intentionally requires a positive maximum. Tooling
  // failures are terminal at the common boundary; a zero tooling budget is
  // represented by one exhausted slot rather than an invented retry.
  const retry = { used, maximum: Math.max(1, maximum) };
  // A repair receipt is observation evidence, never a route decision.  It is
  // intentionally read from the same current Attempt and catalog lineage as
  // the Gate result; Definition decides whether that evidence can be used.
  const repairEvidence = payload.result === "fail" && failureCategory === "semantic"
    ? inspectCanonicalPlanGateRepair({ flowManager, state })
    : null;
  const lineage = {
    sourceAttempt: { id: attempt.id, sequence: attempt.sequence },
    canonicalAttempt: { id: attempt.id, sequence: attempt.sequence },
    sourceFingerprint,
    canonicalFingerprint: resultSource.descriptor.hash,
    sourceRevisionFingerprint,
    canonicalRevisionFingerprint,
  };
  return new GateTransitionFacts({
    phase: persistedPhase,
    scope: scopeFor(persistedPhase, taskId),
    snapshotRevision: snapshot?.revision ?? null,
    producer: {
      runId: state.runId, specId: state.specId, activityId: publication.id, phase: persistedPhase,
      scope: scopeFor(persistedPhase, taskId), taskId, stepId: nodeId,
    },
    target: { runId: state.runId, specId: state.specId, taskId, stepId: nodeId, attempt: { id: attempt.id, sequence: attempt.sequence } },
    currentAttempt: { id: attempt.id, sequence: attempt.sequence },
    catalogPublication: {
      attemptId: attempt.id, sequence: attempt.sequence, producerActivityId: publication.id,
      artifactId: resultSource.relativePath, fingerprint: resultSource.descriptor.hash,
    },
    result: payload.result,
    failure,
    postPublication,
    retry,
    taskBudget: taskId === null ? null : new GateTaskBudget({
      round: flowManager.taskMutationLineages({ specId: state.specId, taskId }).at(-1)?.budget.round,
    }),
    lineage,
    recoveryEvidence: payload.result === "recovered"
      ? { kind: "recovered", attempt: { id: attempt.id, sequence: attempt.sequence }, fingerprint: resultSource.descriptor.hash }
      : repairEvidence !== null
        ? { kind: "repair", attempt: { id: attempt.id, sequence: attempt.sequence }, fingerprint: resultSource.descriptor.hash }
      : { kind: "none" },
    nonblocking: state.policy?.nonblocking?.enabled === true,
    reviewReadiness: persistedPhase === "integration"
      ? integrationReviewReadiness({ flowManager, state })
      : null,
    taskLifecycle: taskLifecycleFor(state, taskId),
    taskSettlementProgress: taskId === null ? null : taskGateSettlementProgress({
      flowManager, state, nodeId, taskId, attempt, publication, activities, producerActivities, failure,
      catalogFingerprint: resultSource.descriptor.hash,
      lineage,
      classificationRecorded,
      classificationMismatch: failureResolution.classificationMismatch,
    }),
  });
}
