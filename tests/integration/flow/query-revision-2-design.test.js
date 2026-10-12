import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { validateSchema } from "../../../src/lib/schema-validate.js";
import { FLOW_QUERY_REQUEST_SCHEMA, FLOW_QUERY_RESPONSE_SCHEMA, FLOW_QUERY_LIMITS } from "../../../src/flow/query-contract.js";
import { ActivityItem, AggregateMetrics, ArtifactDescriptorView, Cursor, MetadataItem } from "../../../src/flow/query.js";

const designDirectory = fileURLToPath(new URL("../../../docs/design/flow-query-revision-2/", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(designDirectory, file), "utf8"));
const requestSchema = read("request.schema.json");
const responseSchema = read("response.schema.json");
const metadata = read("examples/metadata-success.json");
const pages = [read("examples/activities-page-1.json"), read("examples/activities-page-2.json")];
const inputs = read("examples/digest-inputs.json");
const groups = ["evaluations", "findings", "repairs"];
const oldIdFields = { evaluations: "evaluationIds", findings: "findingIds", repairs: "repairIds" };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(Buffer.from(JSON.stringify(canonical(value)), "utf8"));

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label}: duplicate identity`);
}

function assertClosure(page) {
  const entities = new Map(groups.flatMap((group) => page.entities[group].map((entity) => [entity.id, entity])));
  const groupIds = Object.fromEntries(groups.map((group) => [group, new Set(page.entities[group].map((entity) => entity.id))]));
  assert.equal(entities.size, groups.reduce((sum, group) => sum + page.entities[group].length, 0), "duplicate entity identity");
  const requested = [];
  for (const item of page.items) {
    for (const group of groups) {
      const refs = item.detailRefs[group];
      assertUnique(refs, "detailRefs");
      for (const id of refs) assert.ok(groupIds[group].has(id), `wrong entity group or missing detail entity: ${id}`);
      assert.equal(item.detailCoverage[group].count, refs.length);
      const bindings = item.referenceBindings[group];
      assertUnique(bindings.map((binding) => binding.reference.id), "referenceBindings");
      assert.deepEqual([...new Set(bindings.map((binding) => binding.reference.id))].sort(), [...item[oldIdFields[group]]].sort());
      for (const binding of bindings) {
        assert.equal(binding.availability, "available");
        assert.equal(binding.reason, null);
        assert.ok(binding.detailIds.length > 0, "old reference requires a resolved detail");
        for (const id of binding.detailIds) assert.ok(refs.includes(id), "binding absent from detailRefs");
      }
      requested.push(...refs);
    }
  }
  const reached = new Set();
  while (requested.length > 0) {
    const id = requested.pop();
    if (reached.has(id)) continue;
    const entity = entities.get(id);
    assert.ok(entity, `missing detail entity: ${id}`);
    reached.add(id);
    for (const group of groups) {
      for (const targetId of entity[oldIdFields[group]]) {
        assert.ok(groupIds[group].has(targetId), `wrong entity group or missing detail entity: ${targetId}`);
        requested.push(targetId);
      }
    }
  }
  assert.deepEqual([...reached].sort(), [...entities.keys()].sort(), "entities must equal the transitive closure");
  assert.equal(page.pageInfo.returnedItems, page.items.length);
  assert.ok(page.items.length > 0 || page.pageInfo.hasNext === false, "empty non-final page");
}

describe("Flow query revision 2 design artifacts", () => {
  it("retains the production request schema without changing required fields or accepted values", () => {
    const { $schema, $id, title, description, ...body } = requestSchema;
    assert.equal($schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(body, JSON.parse(JSON.stringify(FLOW_QUERY_REQUEST_SCHEMA)));
    for (const file of ["request-metadata.json", "request-activities.json", "request-activities-page-2.json"]) {
      assert.deepEqual(validateSchema(read(`examples/${file}`), requestSchema), [], file);
    }
  });

  it("validates every success and failure example with the existing schema validator", () => {
    assert.equal(responseSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    const { title: documentationTitle, description: documentationDescription, ...documentedContract } = responseSchema;
    const { title: runtimeTitle, description: runtimeDescription, ...runtimeContract } = FLOW_QUERY_RESPONSE_SCHEMA;
    assert.deepEqual(documentedContract, runtimeContract);
    const files = fs.readdirSync(path.join(designDirectory, "examples"));
    for (const file of files.filter((name) => name.endsWith(".json") && !name.startsWith("request-") && name !== "digest-inputs.json")) {
      const value = read(`examples/${file}`);
      assert.deepEqual(validateSchema(value, responseSchema), [], file);
      assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES);
    }
  });

  it("preserves the semantic contracts of the existing typed public fields", () => {
    const { artifacts, metrics } = metadata.item;
    const projected = new MetadataItem({
      ...metadata.item,
      artifacts: artifacts.map((artifact) => new ArtifactDescriptorView(artifact)),
      metrics: new AggregateMetrics(metrics),
    }).toJSON();
    assert.deepEqual(projected, metadata.item);
    for (const page of pages) {
      for (const item of page.items) {
        assert.deepEqual(new ActivityItem(item).toJSON(), item);
      }
    }
  });

  it("rejects missing revision 2 fields, unknown specific semantics and unsupported native status", () => {
    const withoutSnapshot = structuredClone(metadata);
    delete withoutSnapshot.snapshot;
    const unknownSpecific = structuredClone(pages[0]);
    unknownSpecific.entities.findings[0].specific.schemaId = "unknown-producer@1";
    const unsupportedStatus = structuredClone(pages[1]);
    unsupportedStatus.entities.repairs[0].status.value = "assumed-verified";
    const wrongCoverage = structuredClone(pages[0]);
    wrongCoverage.items[0].detailCoverage.findings = { availability: "not-recorded", count: 1, reason: "PRODUCER_DID_NOT_RECORD" };
    const truncatedFailure = read("examples/detail-unavailable.json");
    truncatedFailure.entities = pages[0].entities;
    const unevidencedCurrentState = structuredClone(pages[0]);
    unevidencedCurrentState.entities.findings[0].currentState = {
      status: unevidencedCurrentState.entities.findings[0].status, asOfSnapshotId: metadata.snapshot.id, sources: [],
    };
    for (const value of [withoutSnapshot, unknownSpecific, unsupportedStatus, wrongCoverage, truncatedFailure, unevidencedCurrentState]) {
      assert.ok(validateSchema(value, responseSchema).length > 0);
    }
  });

  it("defines a closed tree with saved node states and distinct Task and Definition Step identities", () => {
    const structure = metadata.item.structure;
    const nodes = new Map(structure.nodes.map((node) => [node.id, node]));
    assert.equal(nodes.size, structure.nodes.length);
    assert.equal(nodes.get(structure.rootNodeId).parentId, null);
    const visited = new Set();
    const walk = (id) => {
      assert.ok(!visited.has(id), "tree contains a cycle or a shared child");
      visited.add(id);
      const node = nodes.get(id);
      assert.ok(node, `missing node: ${id}`);
      assertUnique(node.childIds, "childIds");
      if (node.displayNameSource === "key") {
        assert.equal(node.displayName, node.key);
        assert.equal(node.coverage.displayName, "key-fallback");
      }
      for (const childId of node.childIds) {
        assert.equal(nodes.get(childId)?.parentId, id);
        walk(childId);
      }
    };
    walk(structure.rootNodeId);
    assert.equal(visited.size, nodes.size);
    assert.deepEqual(structure.stepIds, structure.nodes.filter((node) => node.kind === "step").map((node) => node.id));
    assert.deepEqual(structure.taskIds, structure.nodes.filter((node) => node.kind === "task").map((node) => node.id));
    assert.deepEqual(structure.phaseIds, structure.nodes.filter((node) => node.role === "phase").map((node) => node.id));
    const task = nodes.get("T-1");
    const step = nodes.get("T-1-impl");
    assert.equal(task.kind, "task");
    assert.equal(task.definitionStepId, null);
    assert.equal(step.taskId, task.id);
    assert.equal(step.definitionStepId, "task-impl");
    assert.notEqual(step.id, step.definitionStepId);
    assert.deepEqual(metadata.item.relationships.stepTasks, [{ stepId: step.id, taskId: task.id }]);
    assert.equal(nodes.get("spec").status, "in_progress");
    assert.equal(nodes.get("spec-review").status, "done");
  });

  it("merges pages by identity without omitting dependency details or duplicating Activities", () => {
    const merged = new Map();
    for (const page of pages) {
      assertClosure(page);
      assert.equal(page.snapshot.id, metadata.snapshot.id);
      for (const group of groups) {
        for (const entity of page.entities[group]) {
          if (merged.has(entity.id)) assert.deepEqual(entity, merged.get(entity.id));
          merged.set(entity.id, entity);
        }
      }
    }
    assert.notEqual(pages[0].snapshot.capturedAt, pages[1].snapshot.capturedAt);
    assert.equal(pages[0].pageInfo.hasNext, true);
    assert.equal(pages[1].pageInfo.hasNext, false);
    assert.equal(pages.reduce((count, page) => count + page.pageInfo.returnedItems, 0), pages[0].pageInfo.totalItems);
    assert.equal(pages[1].pageInfo.totalItems, pages[0].pageInfo.totalItems);
    assertUnique(pages.flatMap((page) => page.items.map((item) => item.activity.id)), "Activity IDs");
    assert.equal(merged.size, 3);
    assert.equal(pages[1].items[0].evaluationIds.length, 0);
    assert.equal(pages[1].entities.evaluations.length, 1);
    const missingDependency = structuredClone(pages[1]);
    missingDependency.entities.evaluations = [];
    assert.throws(() => assertClosure(missingDependency), /missing detail entity/);
    const duplicateBinding = structuredClone(pages[0]);
    duplicateBinding.items[0].referenceBindings.evaluations.push(duplicateBinding.items[0].referenceBindings.evaluations[0]);
    assert.throws(() => assertClosure(duplicateBinding), /referenceBindings: duplicate identity/);
    const wrongGroup = structuredClone(pages[0]);
    wrongGroup.items[0].detailRefs.evaluations = [wrongGroup.entities.findings[0].id];
    assert.throws(() => assertClosure(wrongGroup), /wrong entity group/);
  });

  it("reproduces publication IDs, path keys, entity IDs and exact source-byte hashes", () => {
    const artifacts = metadata.item.artifacts;
    for (const [index, publication] of inputs.publicationIdentities.entries()) {
      const artifact = artifacts[index];
      const bytes = fs.readFileSync(path.join(designDirectory, "examples", inputs.sourceFiles[index]));
      assert.equal(artifact.artifactId, digest(publication));
      assert.equal(artifact.hash, hash(bytes));
      assert.equal(artifact.size, bytes.length);
      const keyInput = { flowVersionId: metadata.item.identity.flowVersionId, relativePath: artifact.relativePath, kind: artifact.kind, authority: artifact.authority, cardinality: artifact.cardinality, memberId: artifact.memberId };
      assert.equal(artifact.artifactKey, `artifact:${digest(keyInput)}`);
      assert.equal(path.posix.normalize(artifact.relativePath), artifact.relativePath);
      assert.equal(path.posix.isAbsolute(artifact.relativePath), false);
      assert.equal(artifact.cardinality, "collection");
      assert.notEqual(artifact.memberId, null);
      assert.equal(digest({ ...publication, hash: hash(Buffer.from("changed bytes")) }) === artifact.artifactId, false);
    }
    const [evaluation] = pages[0].entities.evaluations;
    const [finding] = pages[0].entities.findings;
    const [repair] = pages[1].entities.repairs;
    assert.equal(evaluation.id, `evaluation:${digest(inputs.evaluationInputs)}`);
    assert.equal(finding.id, `finding:${digest(inputs.findingInputs)}`);
    assert.equal(finding.findingKey, `finding:${digest({ flowVersionId: metadata.item.identity.flowVersionId, identity: finding.identity })}`);
    assert.equal(repair.id, `repair:${digest(inputs.repairInputs)}`);
    assert.notEqual(finding.id, finding.findingKey);
    const artifactMap = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    for (const entity of [evaluation, finding, repair]) {
      for (const source of [entity.source, ...entity.supportingSources]) {
        const artifact = artifactMap.get(source.artifactId);
        assert.ok(artifact);
        for (const field of ["artifactKey", "relativePath", "hash", "producerActivityId"]) assert.equal(source[field], artifact[field]);
      }
    }
    assert.equal(repair.status.value, "applied");
    assert.equal(finding.status.value, "open");
    assert.equal(finding.currentState, null);
  });

  it("binds snapshot and cursor identities independently of capture time", () => {
    assert.equal(metadata.snapshot.id, `sha256:${digest(inputs.snapshotInputs)}`);
    assert.equal(metadata.snapshot.availableFlowVersionsHash, digest(metadata.availableFlowVersions));
    const ledgerBytes = fs.readFileSync(path.join(designDirectory, "examples", inputs.confirmedLedgerFile));
    assert.equal(inputs.snapshotInputs.confirmedLedgerHash, hash(ledgerBytes));
    for (const [field, file] of Object.entries(inputs.snapshotFiles)) {
      assert.equal(inputs.snapshotInputs[field], hash(fs.readFileSync(path.join(designDirectory, "examples", file))), field);
    }
    for (const [index, page] of pages.entries()) {
      const cursor = JSON.parse(Buffer.from(page.pageInfo.endCursor, "base64url").toString("utf8"));
      const { digest: cursorDigest, ...payload } = cursor;
      assert.deepEqual(payload, inputs.cursorInputs[index]);
      assert.equal(cursorDigest, digest(payload));
      assert.equal(payload.snapshotId, page.snapshot.id);
      assert.equal(payload.order, page.items.at(-1).confirmationOrder);
      assert.equal(Cursor.decode(page.pageInfo.endCursor, payload, { snapshotId: page.snapshot.id }), payload.order);
      assert.equal(new Cursor({ request: payload, order: payload.order, snapshotId: page.snapshot.id }).encode(), page.pageInfo.endCursor);
      assert.notEqual(digest({ ...payload, specId: "different-flow" }), cursorDigest);
      assert.notEqual(digest({ ...payload, snapshotId: `sha256:${"0".repeat(64)}` }), cursorDigest);
      assert.equal(page.pageInfo.endCursor.includes("="), false);
    }
    assert.equal(read("examples/request-activities-page-2.json").page.after, pages[0].pageInfo.endCursor);
  });

  it("projects recorded source content without inventing detail text or old reference IDs", () => {
    const review = read(`examples/${inputs.sourceFiles[0]}`);
    const repair = read(`examples/${inputs.sourceFiles[1]}`);
    const evaluation = pages[0].entities.evaluations[0];
    const finding = pages[0].entities.findings[0];
    const repairEntity = pages[1].entities.repairs[0];
    for (const entity of [evaluation, finding, repairEntity]) {
      const fileIndex = metadata.item.artifacts.findIndex((artifact) => artifact.artifactId === entity.source.artifactId);
      const document = read(`examples/${inputs.sourceFiles[fileIndex]}`);
      assert.equal(entity.source.format, "json");
      let record = document;
      const segments = entity.source.jsonPointer === "" ? [] : entity.source.jsonPointer.slice(1).split("/");
      for (const segment of segments) record = record[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
      assert.equal(record.id, entity.source.sourceEntryId);
      assert.equal(document.observationId, entity.source.observationId);
    }
    for (const field of ["title", "summary", "explanation", "result"]) {
      assert.deepEqual(evaluation[field], review.evaluation[field], field);
    }
    assert.deepEqual(evaluation.criteria, review.evaluation.criteria.map((criterion) => ({ ...criterion, category: criterion.category ?? null, authority: criterion.authority ?? null })));
    const record = review.findings[0];
    for (const field of ["title", "description", "reason", "expected", "observed", "recommendation", "evidence", "severity"]) {
      assert.equal(finding[field], record[field], field);
    }
    for (const field of ["target", "issue", "requiredChange", "whyBlocking"]) assert.equal(finding.specific[field], record[field], field);
    assert.equal(finding.status.nativeValue, record.status);
    assert.equal(finding.source.sourceEntryId, record.id);
    assert.equal(finding.source.observationId, review.observationId);
    assert.equal(evaluation.source.sourceEntryId, review.evaluation.id);
    for (const field of ["title", "description", "reason"]) assert.equal(repairEntity[field], repair[field], field);
    assert.equal(repairEntity.status.nativeValue, repair.status);
    assert.equal(repairEntity.source.sourceEntryId, repair.id);
    const item = repairEntity.items[0];
    for (const field of ["id", "operationKind", "adoptedReason", "discardedReason"]) {
      assert.deepEqual(item[field], repair.items[0][field], field);
    }
    assert.deepEqual(item.target, { ...repair.items[0].target, collection: null, position: null });
    assert.equal(item.status.nativeValue, repair.items[0].status);
    assert.equal(item.evidence[0].summary, repair.items[0].evidence);
    const ledger = fs.readFileSync(path.join(designDirectory, "examples", inputs.confirmedLedgerFile), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    for (const page of pages) {
      for (const activity of page.items) {
        const saved = ledger.find((entry) => entry.id === activity.activity.id);
        assert.equal(saved.confirmationOrder, activity.confirmationOrder);
        for (const group of groups) {
          assert.deepEqual(activity[oldIdFields[group]], saved.references[group].map((entry) => entry.id));
          assert.deepEqual(activity.referenceBindings[group].map((entry) => entry.reference), saved.references[group]);
        }
      }
    }
    assert.equal(metadata.item.metrics.durationMs, ledger.reduce((sum, activity) => sum + (activity.durationMs ?? 0), 0));
  });

  it("makes each failure atomic and does not substitute coverage for unreadable details", () => {
    const expected = {
      "snapshot-changed.json": "SNAPSHOT_CHANGED",
      "detail-unavailable.json": "DETAIL_UNAVAILABLE",
      "artifact-inconsistent.json": "CANONICAL_RECORD_INCONSISTENT",
      "response-too-large.json": "RESPONSE_TOO_LARGE",
      "snapshot-unstable.json": "SNAPSHOT_UNSTABLE",
    };
    for (const [file, code] of Object.entries(expected)) {
      const response = read(`examples/${file}`);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.equal(response.completeness, null);
      if (response.resource === "metadata") assert.equal(response.item, null);
      else {
        assert.deepEqual(response.items, []);
        assert.deepEqual(response.entities, { evaluations: [], findings: [], repairs: [] });
        assert.equal(response.pageInfo.hasNext, false);
        assert.equal(response.pageInfo.returnedItems, 0);
      }
    }
    assert.equal(read("examples/detail-unavailable.json").error.reason, "SOURCE_GENERATION_NOT_RETAINED");
    assert.equal(read("examples/artifact-inconsistent.json").snapshot, null);
    assert.equal(read("examples/snapshot-unstable.json").snapshot, null);
    assert.equal(metadata.item.history.ledgerCoverage, "complete");
    assert.equal(pages[0].completeness.scope, "filtered-activities");
    assert.equal(pages[0].completeness.details, "complete");
    assert.equal(pages[0].completeness.sourceHistory, "complete");
  });
});
