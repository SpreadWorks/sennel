import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFlowStopGuidance } from "../../src/lib/flow-stop-guidance.js";
import {
  FLOW_QUERY_SCHEMA_REVISION,
  validateFlowQueryRequest,
  validateFlowQueryResponse,
} from "../../src/flow/query-contract.js";

const hash = "a".repeat(64);
const snapshotId = `sha256:${hash}`;
const evaluationId = `evaluation:${hash}`;
const source = () => ({
  artifactId: hash, artifactKey: `artifact:${hash}`, relativePath: "steps/review/result.json", hash,
  producerActivityId: "activity-1", nodeId: "review", attemptId: "attempt-1",
  sourceEntryId: "evaluation-1", observationId: "observation-1", format: "json", jsonPointer: "/evaluation",
});

function activities() {
  const coverage = (availability) => ({ availability, reason: availability === "available" ? null : "NOT_APPLICABLE", count: 0 });
  return {
    schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: true, resource: "activities",
    selectedFlowVersion: { specId: "sample", flowVersion: 1 }, availableFlowVersions: [1],
    snapshot: { id: snapshotId, algorithm: "sha256", capturedAt: "2026-01-01T00:00:00Z", confirmationOrder: 1, catalogHash: hash, projectionHash: hash, availableFlowVersionsHash: hash },
    completeness: { scope: "flow-version", enumeration: "complete", details: "complete", sourceHistory: "complete" },
    items: [{
      activity: { id: "activity-1", type: "attempt_confirmed" }, node: { id: "review", key: "review" }, task: null,
      attempt: { id: "attempt-1", sequence: 1 }, sequence: 1, confirmationOrder: 1,
      transition: { operation: "confirm_attempt", status: "done" }, timing: null, usage: null, outcome: null,
      failure: null, blocker: null, incomplete: null, metric: null, note: null,
      evaluationIds: ["legacy-1"], findingIds: [], repairIds: [], artifactIds: [hash],
      detailRefs: { evaluations: [evaluationId], findings: [], repairs: [] },
      referenceBindings: { evaluations: [{ reference: { id: "legacy-1", label: null }, detailIds: [evaluationId], availability: "available", reason: null }], findings: [], repairs: [] },
      detailCoverage: { evaluations: { availability: "available", reason: null, count: 1 }, findings: coverage("not-applicable"), repairs: coverage("not-applicable") },
    }],
    entities: {
      evaluations: [{
        id: evaluationId, kind: "evaluation", source: source(), supportingSources: [], activityIds: ["activity-1"],
        evaluationIds: [], findingIds: [], repairIds: [], title: null, summary: null, explanation: null,
        result: { outcome: "passed", nativeCode: "PASS" }, criteria: [], specific: null,
      }], findings: [], repairs: [],
    },
    pageInfo: { limit: 1, returnedItems: 1, totalItems: 1, hasNext: false, endCursor: null },
  };
}

function metadata() {
  const value = activities();
  delete value.items;
  delete value.entities;
  delete value.pageInfo;
  value.resource = "metadata";
  const timestamp = { value: null, availability: "unavailable", reason: "not recorded", provenance: "confirmed-activity-prefix" };
  value.item = {
    identity: { flowId: "flow-1", flowVersionId: "version-1", runId: "run-1", specId: "sample", flowVersion: 1 },
    history: { origin: "native", ledgerCoverage: "complete", execution: "native", continuation: null },
    lifecycle: { lifecycle: "active", blocked: false, blocker: null, nextAction: null },
    location: { phase: null, stepId: null, taskId: null, git: { available: false, commit: null } },
    structure: {
      phaseId: "flow", stepIds: [], taskIds: [], rootNodeId: "flow", phaseIds: [],
      nodes: [{ id: "flow", key: "flow", kind: "flow", role: "flow", displayName: "flow", displayNameSource: "key", status: "pending", parentId: null, childIds: [], phaseId: null, taskId: null, attemptSequence: 0, result: null, definitionStepId: null, coverage: { phaseClassification: "not-applicable", displayName: "key-fallback" } }],
    },
    relationships: { stepTasks: [], taskNodes: [], issues: [] },
    timestamps: { createdAt: timestamp, updatedAt: timestamp, finalizedAt: timestamp }, capabilities: {}, artifacts: [],
    metrics: {
      activityCount: 1, artifactCount: 0, stepCount: 0, taskCount: 0, durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cost: null,
      provenance: { activityCount: "confirmed-activity-prefix", artifactCount: "canonical-artifact-catalog", stepCount: "canonical-state", taskCount: "canonical-state", durationMs: "activity-timing-durationMs", inputTokens: "activity-usage-inputTokens", outputTokens: "activity-usage-outputTokens", cacheReadTokens: "activity-usage-cacheReadTokens", cost: "activity-usage-cost" },
    },
  };
  return value;
}

function findingResponse() {
  const value = activities();
  const findingId = `finding:${hash}`;
  value.entities.evaluations[0].findingIds = [findingId];
  value.entities.findings = [{
    id: findingId, kind: "finding", source: source(), supportingSources: [], activityIds: ["activity-1"],
    evaluationIds: [evaluationId], findingIds: [], repairIds: [],
    identity: { sourceArtifact: "steps/review/result.json", sourceStep: "review", sourceFindingId: "finding-1", fingerprint: hash },
    findingKey: `finding:${"b".repeat(64)}`, title: null, description: null, reason: null, expected: null,
    observed: null, recommendation: null, evidence: null, severity: null,
    status: { value: "open", availability: "available", reason: null, nativeValue: "open" }, currentState: null,
    specific: { schemaId: "draft-finding@1", classification: "blocking", target: "scope", rationale: "saved finding", evidence: "saved rationale" },
  }];
  return value;
}

function repairResponse() {
  const value = findingResponse();
  const finding = value.entities.findings[0];
  const repairId = `repair:${hash}`;
  finding.repairIds = [repairId];
  value.entities.repairs = [{
    id: repairId, kind: "repair", source: source(), supportingSources: [], activityIds: ["activity-1"],
    evaluationIds: [], findingIds: [finding.id], repairIds: [], title: null, description: null, reason: null,
    status: { value: "applied", availability: "available", reason: null, nativeValue: "merged" }, currentState: null,
    items: [{ id: "operation-1", target: { entity: null, id: null, field: null, relativePath: null, jsonPointer: null, collection: "scope.in", position: 1 },
      operationKind: "replace", status: { value: "applied", availability: "available", reason: null, nativeValue: "applied" }, adoptedReason: null, discardedReason: null, evidence: [], findingIds: [finding.id] }],
    specific: null,
  }];
  return value;
}

describe("Flow Query public response contract", () => {
  it("publishes revision 3 while preserving request resource, conditions and page requirements", () => {
    assert.equal(FLOW_QUERY_SCHEMA_REVISION, 3);
    assert.deepEqual(validateFlowQueryRequest({ resource: "metadata", condition: { specId: "sample" } }), []);
    assert.deepEqual(validateFlowQueryRequest({ resource: "activities", condition: { specId: "sample" }, page: { limit: 100, after: null } }), []);
    assert.notEqual(validateFlowQueryRequest({ resource: "activities", condition: { specId: "sample" } }).length, 0);
    assert.notEqual(validateFlowQueryRequest({ resource: "metadata", condition: { specId: "sample" }, snapshotId }).length, 0);
  });

  it("accepts a resolved detail closure and a connected saved metadata tree", () => {
    assert.deepEqual(validateFlowQueryResponse(activities()), []);
    assert.deepEqual(validateFlowQueryResponse(metadata()), []);
  });

  const invalidActivities = [
    ["duplicate legacy binding", (v) => v.items[0].referenceBindings.evaluations.push(v.items[0].referenceBindings.evaluations[0]), "referenceBindings"],
    ["unresolved old reference", (v) => { v.items[0].referenceBindings.evaluations[0].detailIds = []; }, "detailIds"],
    ["changed old reference identity", (v) => { v.items[0].referenceBindings.evaluations[0].reference.id = "other"; }, "referenceBindings"],
    ["wrong detail group", (v) => { v.items[0].detailRefs.findings = [evaluationId]; v.items[0].detailCoverage.findings = { availability: "available", reason: null, count: 1 }; }, "detailRefs.findings"],
    ["unresolved dependency", (v) => { v.entities.evaluations[0].repairIds = [`repair:${hash}`]; }, "repairIds"],
    ["duplicate entity", (v) => v.entities.evaluations.push(v.entities.evaluations[0]), "entities.evaluations"],
    ["unreferenced entity outside closure", (v) => v.entities.evaluations.push({ ...v.entities.evaluations[0], id: `evaluation:${"b".repeat(64)}` }), "transitive"],
    ["coverage count mismatch", (v) => { v.items[0].detailCoverage.evaluations.count = 0; }, "detailCoverage"],
    ["page count mismatch", (v) => { v.pageInfo.returnedItems = 0; }, "pageInfo.returnedItems"],
    ["empty nonfinal page", (v) => { v.items = []; v.entities.evaluations = []; v.pageInfo.returnedItems = 0; v.pageInfo.hasNext = true; }, "pageInfo.hasNext"],
    ["activity beyond the confirmed snapshot prefix", (v) => { v.snapshot.confirmationOrder = 0; }, "confirmationOrder"],
    ["impossible snapshot datetime", (v) => { v.snapshot.capturedAt = "2026-02-30T00:00:00Z"; }, "snapshot.capturedAt"],
    ["JSON source without a pointer", (v) => { v.entities.evaluations[0].source.jsonPointer = null; }, "jsonPointer"],
    ["source traversal", (v) => { v.entities.evaluations[0].source.relativePath = "../result.json"; }, "relativePath"],
  ];
  for (const [behavior, mutate, errorPath] of invalidActivities) {
    it(`rejects ${behavior}`, () => {
      const value = activities();
      mutate(value);
      assert.ok(validateFlowQueryResponse(value).some((error) => error.includes(errorPath)));
    });
  }

  for (const [behavior, mutate, errorPath] of [
    ["disconnected tree", (v) => { v.item.structure.nodes[0].parentId = "absent"; }, "rootNodeId"],
    ["cycle", (v) => { v.item.structure.nodes[0].childIds = ["flow"]; }, "cycle"],
    ["incorrect structure ID list", (v) => { v.item.structure.taskIds = ["absent"]; }, "taskIds"],
    ["invented display-name fallback", (v) => { v.item.structure.nodes[0].displayName = "invented"; }, "displayName"],
    ["complete coverage for partial source history", (v) => { v.item.history = { origin: "historical", execution: "dormant", ledgerCoverage: "partial", continuation: null }; }, "sourceHistory"],
  ]) {
    it(`rejects metadata with ${behavior}`, () => {
      const value = metadata();
      mutate(value);
      assert.ok(validateFlowQueryResponse(value).some((error) => error.includes(errorPath)));
    });
  }

  it("permits producer-declared missing details and marks their coverage", () => {
    const value = activities();
    value.items[0].evaluationIds = [];
    value.items[0].referenceBindings.evaluations = [];
    value.items[0].detailRefs.evaluations = [];
    value.items[0].detailCoverage.evaluations = { availability: "not-recorded", reason: "PRODUCER_DID_NOT_RECORD", count: 0 };
    value.entities.evaluations = [];
    value.completeness.details = "not-recorded";
    assert.deepEqual(validateFlowQueryResponse(value), []);
  });

  it("preserves known native status and rejects unsupported status rather than publishing unavailable detail", () => {
    const value = findingResponse();
    assert.deepEqual(validateFlowQueryResponse(value), []);
    value.entities.findings[0].status = { value: null, availability: "not-recorded", reason: "PRODUCER_DID_NOT_RECORD", nativeValue: null };
    assert.deepEqual(validateFlowQueryResponse(value), []);
    value.entities.findings[0].status = { value: "assumed-fixed", availability: "available", reason: null, nativeValue: "assumed-fixed" };
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    value.entities.findings[0].status = { value: null, availability: "unavailable", reason: "DETAIL_UNAVAILABLE", nativeValue: "assumed-fixed" };
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
  });

  it("requires current state evidence bound to this snapshot", () => {
    const value = findingResponse();
    const finding = value.entities.findings[0];
    finding.currentState = { status: finding.status, asOfSnapshotId: snapshotId, sources: [source()] };
    assert.deepEqual(validateFlowQueryResponse(value), []);
    finding.currentState.asOfSnapshotId = `sha256:${"b".repeat(64)}`;
    assert.ok(validateFlowQueryResponse(value).some((error) => error.includes("asOfSnapshotId")));
    finding.currentState.asOfSnapshotId = snapshotId;
    finding.currentState.sources = [];
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
  });

  it("retains collection repair positions and requires explicit unrelated null fields", () => {
    const value = repairResponse();
    assert.deepEqual(validateFlowQueryResponse(value), []);
    const target = value.entities.repairs[0].items[0].target;
    target.position = null;
    assert.deepEqual(validateFlowQueryResponse(value), []);
    delete target.position;
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    target.position = -1;
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    target.position = Number.MAX_SAFE_INTEGER + 1;
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    target.position = null;
    target.collection = null;
    target.entity = "requirement";
    target.id = "R-1";
    target.field = "desc";
    assert.deepEqual(validateFlowQueryResponse(value), []);
  });

  it("preserves recorded Gate metadata and criterion classification with a closed specific variant", () => {
    const value = activities();
    const evaluation = value.entities.evaluations[0];
    evaluation.criteria = [{ id: "G-1", title: "Recorded title", category: "guardrail", authority: "mechanical", expected: null, observed: null, evidence: "Recorded explanation", result: "passed" }];
    evaluation.specific = { schemaId: "gate-evaluation@1", target: "spec.json", level: "spec", phase: "spec", reasons: [{ verdict: "PASS", detail: "recorded reason", guardrailId: "G-1", category: "guardrail", where: null }], issues: [], failureKind: null, failureCode: null, prescription: null, diagnosisSummary: null,
      taskId: null, sourceFingerprint: null, failureCategory: null,
      evaluationScope: { phase: "spec", taskId: null, sourceFingerprint: null, contentFingerprint: hash },
      warnings: ["Recorded source warning"] };
    assert.deepEqual(validateFlowQueryResponse(value), []);
    evaluation.criteria[0].category = null;
    assert.deepEqual(validateFlowQueryResponse(value), []);
    delete evaluation.criteria[0].category;
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    evaluation.criteria[0].category = "guardrail";
    evaluation.specific.unknownMeaning = "unregistered";
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
  });

  it("requires recorded Gate scope fields and preserves nullable mechanical authority", () => {
    const value = activities();
    const evaluation = value.entities.evaluations[0];
    evaluation.criteria = [{ id: "G-1", title: null, category: null, authority: null,
      expected: null, observed: null, evidence: "Recorded explanation", result: "passed" }];
    const specific = { schemaId: "gate-evaluation@1", target: null, level: null, phase: "task-impl",
      reasons: [], issues: [], failureKind: null, failureCode: null, prescription: null, diagnosisSummary: null,
      taskId: "T-1", sourceFingerprint: hash, failureCategory: null,
      evaluationScope: { phase: "task-impl", taskId: "T-1", sourceFingerprint: hash, contentFingerprint: hash }, warnings: null };
    evaluation.specific = specific;
    assert.deepEqual(validateFlowQueryResponse(value), []);
    for (const field of ["taskId", "sourceFingerprint", "failureCategory", "evaluationScope", "warnings"]) {
      const recorded = specific[field];
      delete specific[field];
      assert.notEqual(validateFlowQueryResponse(value).length, 0, field);
      specific[field] = recorded;
    }
    evaluation.criteria[0].authority = "guessed";
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
    evaluation.criteria[0].authority = "mechanical";
    evaluation.result = { outcome: "failed", nativeCode: "fail" };
    specific.failureCategory = { category: "semantic", code: "GATE_REJECTED" };
    assert.deepEqual(validateFlowQueryResponse(value), []);
    specific.failureCategory.category = "guessed";
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
  });

  it("requires failed responses to be empty and to use the declared error path", () => {
    const value = { schemaRevision: FLOW_QUERY_SCHEMA_REVISION, ok: false, resource: "activities", selectedFlowVersion: null, availableFlowVersions: [], snapshot: null, completeness: null,
      guidance: buildFlowStopGuidance({ code: "SNAPSHOT_CHANGED" }).toJSON(),
      error: { code: "SNAPSHOT_CHANGED", path: "/page/after", message: "snapshot changed", reason: "SNAPSHOT_ID_MISMATCH", referenceId: null },
      items: [], entities: { evaluations: [], findings: [], repairs: [] }, pageInfo: { limit: 1, endCursor: null, hasNext: false, returnedItems: 0, totalItems: null } };
    assert.deepEqual(validateFlowQueryResponse(value), []);
    value.error.path = "/canonical";
    assert.ok(validateFlowQueryResponse(value).some((error) => error.startsWith("error.path:")));
    value.error.path = "/page/after";
    value.entities.evaluations = activities().entities.evaluations;
    assert.notEqual(validateFlowQueryResponse(value).length, 0);
  });
});
