import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { describe, it, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { createFlowQueryFixture, queryFixtureLimits } from "../../support/builders/flow-query-fixture.js";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";
import {
  Cursor,
  FLOW_QUERY_ERROR_CODES,
  FLOW_QUERY_SCHEMA_REVISION,
  prepareFlowQueryInput,
  QueryRequest,
} from "../../../src/flow/query.js";

const CLI = path.join(process.cwd(), "src/sennel.js");

function canonicalArtifactIdentity(value) {
  if (Array.isArray(value)) return value.map(canonicalArtifactIdentity);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalArtifactIdentity(value[key])]));
  }
  return value;
}

function expectedArtifactId(descriptor) {
  const identity = Object.fromEntries([
    "logicalKey", "kind", "relativePath", "hash", "size", "mediaType", "authority",
    "cardinality", "memberId", "publicationStep", "retention", "activityId", "migrationMaterialization",
  ].map((field) => [field, descriptor[field]]));
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalArtifactIdentity(identity)), "utf8")
    .digest("hex");
}

function assertNoInternalFields(value) {
  const forbidden = new Set(["relativePath", "recordRevision", "catalog", "body", "checkpoint", "lock", "state"]);
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, `public response leaked internal field: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

describe("flow query", () => {
  let tmp = null;
  const fixtureRoots = [];

  afterEach(() => {
    if (tmp !== null) removeTmpDir(tmp);
    tmp = null;
    while (fixtureRoots.length > 0) removeTmpDir(fixtureRoots.pop());
  });

  function contractFixture(options = {}) {
    const fixture = createFlowQueryFixture(options);
    fixtureRoots.push(fixture.root);
    return fixture;
  }

  function runQuery(fixture, request, { input = JSON.stringify(request), args = [] } = {}) {
    return spawnSync(process.execPath, [CLI, "flow", "query", ...args], {
      cwd: fixture.root,
      env: fixture.env,
      input,
      encoding: "utf8",
    });
  }

  function queryFixture(fixture, request) {
    const result = runQuery(fixture, request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const response = JSON.parse(result.stdout);
    new FlowQueryConsumer().consumeSerialized(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), [
      "availableFlowVersions", "item", "ok", "resource", "schemaRevision", "selectedFlowVersion",
    ].sort());
    assert.deepEqual(Object.keys(response.item).sort(), [
      "artifacts", "capabilities", "identity", "lifecycle", "location", "metrics",
      "relationships", "structure", "timestamps",
    ].sort());
    return response;
  }

  function assertKnownResourceError(response, resource, code, jsonPath, { pageLimit = null } = {}) {
    const consumed = new FlowQueryConsumer().consume(response);
    assert.deepEqual(Object.keys(response).sort(), [
      "availableFlowVersions", "error", "ok", "resource", "schemaRevision", "selectedFlowVersion",
      ...(resource === "metadata" ? ["item"] : ["items", "pageInfo"]),
    ].sort());
    assert.equal(response.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
    assert.equal(response.ok, false);
    assert.equal(response.resource, resource);
    assert.equal(consumed.resource, resource);
    assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path"]);
    assert.equal(response.error.code, code);
    assert.equal(response.error.path, jsonPath);
    assert.doesNotMatch(JSON.stringify(response.error), /flow\.json|artifact-catalog|\.runtime|lock/);
    assertNoInternalFields(response);
    if (resource === "metadata") assert.equal(response.item, null);
    else {
      assert.deepEqual(response.items, []);
      assert.deepEqual(response.pageInfo, { limit: pageLimit, endCursor: null, hasNext: false });
    }
  }

  function createFlow({ withTask = false } = {}) {
    tmp = createTmpDir();
    const flowManager = makeFlowManager(tmp);
    const flow = new CanonicalFlowFixture({
      flowManager,
      specId: "001-query",
      runId: "run-query",
      specRecord: { goal: "query fixture" },
    }).create();
    if (withTask) {
      flow.addTask({
        id: "T-1",
        title: "Query fixture task",
        goal: "Exercise the Activity projection.",
        parent: null,
        origin: "plan",
        added_round: 0,
        status: "pending",
      });
    }
    flow.registerActive();
    return {
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      request: { resource: "metadata", condition: { specId: "001-query" } },
      flow,
      flowManager,
    };
  }

  function query(env, request) {
    const serialized = execFileSync("node", [CLI, "flow", "query"], {
      env,
      input: JSON.stringify(request),
      encoding: "utf8",
    });
    const response = JSON.parse(serialized);
    new FlowQueryConsumer().consumeSerialized(serialized);
    return response;
  }

  it("projects metadata from the canonical Version without mutating it", () => {
    const fixture = createFlow();
    const before = fs.readFileSync(path.join(tmp, "specs", "001-query", "001", "flow.json"));
    const output = execFileSync("node", [CLI, "flow", "query"], {
      env: fixture.env,
      input: JSON.stringify(fixture.request),
      encoding: "utf8",
    });
    const response = JSON.parse(output);
    assert.equal(response.ok, true);
    assert.equal(response.resource, "metadata");
    assert.equal(response.item.identity.specId, "001-query");
    assert.deepEqual(fs.readFileSync(path.join(tmp, "specs", "001-query", "001", "flow.json")), before);
  });

  it("returns confirmed Activities with a bounded page", () => {
    const fixture = createFlow();
    const response = query(fixture.env, {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 1, after: null },
    });
    assert.equal(response.ok, true);
    assert.equal(response.resource, "activities");
    assert.equal(response.items.length, 1);
    assert.equal(response.pageInfo.limit, 1);
  });

  it("paginates by confirmationOrder without gaps or duplicates", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const request = {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 2, after: null },
    };
    const pages = [];
    let after = null;
    do {
      const response = query(fixture.env, { ...request, page: { limit: 2, after } });
      pages.push(response);
      after = response.pageInfo.endCursor;
    } while (pages.at(-1).pageInfo.hasNext);
    const repeat = query(fixture.env, request);

    const orders = pages.flatMap((page) => page.items.map((item) => item.confirmationOrder));
    assert.ok(pages.length > 1);
    assert.equal(pages[0].pageInfo.hasNext, true);
    assert.equal(repeat.pageInfo.endCursor, pages[0].pageInfo.endCursor);
    assert.ok(pages.every((page) => page.ok === true));
    const expectedOrders = Array.from({ length: fixture.flow.state().confirmationOrder }, (_, index) => index + 1);
    assert.deepEqual(orders, expectedOrders);
    assert.equal(pages.at(-1).pageInfo.hasNext, false);
  });

  it("keeps a cursor position stable when the active ledger receives an unconfirmed suffix", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const request = {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 1, after: null },
    };
    const first = query(fixture.env, request);
    const location = fixture.flow.location();
    const ledger = fs.readFileSync(location.activitiesFile, "utf8");
    fs.appendFileSync(location.activitiesFile, `${ledger.split("\n")[0]}\n`);

    const next = query(fixture.env, {
      ...request,
      page: { limit: 1, after: first.pageInfo.endCursor },
    });
    assert.equal(next.ok, true);
    assert.equal(next.items[0].confirmationOrder, 2);
  });

  it("projects the exact Activity shape and filters by timing.finishedAt", () => {
    const fixture = createFlow();
    const finishedAt = fixture.flowManager.activityLedger("001-query")[0].timing.finishedAt;
    const response = query(fixture.env, {
      resource: "activities",
      condition: { specId: "001-query" },
      recordedAt: {
        gte: finishedAt,
        lt: new Date(Date.parse(finishedAt) + 1).toISOString(),
      },
    });
    const item = response.items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      "activity", "artifactIds", "attempt", "blocker", "confirmationOrder", "evaluationIds",
      "failure", "findingIds", "incomplete", "metric", "node", "note", "outcome", "repairIds",
      "sequence", "task", "timing", "transition", "usage",
    ].sort());
    assert.deepEqual(item.activity, { id: fixture.flowManager.activityLedger("001-query")[0].id, type: "flow_created" });
    assert.deepEqual(item.node, { id: "flow-run-query", key: "flow" });
    assert.equal(item.task, null);
    assert.equal(item.attempt, null);
    assert.equal(item.sequence, null);
    assert.equal(item.confirmationOrder, 1);
    assert.deepEqual(item.transition, { operation: "create_flow", status: null });
    assert.deepEqual(item.timing, { startedAt: finishedAt, finishedAt, durationMs: 0 });
    assert.equal(item.usage, null);
    assert.equal(item.outcome, null);
    assert.equal(item.failure, null);
    assert.equal(item.blocker, null);
    assert.equal(item.incomplete, null);
    assert.equal(item.metric, null);
    assert.equal(item.note, null);
    assert.deepEqual(item.evaluationIds, []);
    assert.deepEqual(item.findingIds, []);
    assert.deepEqual(item.repairIds, []);
    assert.deepEqual(item.artifactIds, []);

    const zeroMatch = query(fixture.env, {
      resource: "activities",
      condition: { specId: "001-query" },
      recordedAt: { gte: new Date(Date.parse(finishedAt) + 1).toISOString(), lt: null },
    });
    assert.equal(zeroMatch.ok, true);
    assert.deepEqual(zeroMatch.items, []);
    assert.equal(zeroMatch.pageInfo.endCursor, null);
  });

  it("projects a confirmed Task Activity outcome using the canonical prefix", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const response = query(fixture.env, {
      resource: "activities",
      condition: { specId: "001-query" },
    });
    const item = response.items.find((entry) => entry.activity.type === "result_confirmed");
    assert.ok(item);
    assert.deepEqual(item.task, { id: "T-1", key: "T-1" });
    assert.equal(item.outcome.outcome, "passed");
    assert.equal(item.outcome.summary, "Fixture Task implementation completed without source mutation.");
    assert.deepEqual(item.outcome.artifactRefs, []);
    assert.equal(item.failure, null);
    assert.equal(item.blocker, null);
    assert.equal(item.incomplete, null);
  });

  it("rejects invalid requests and simultaneous stdin/request-file input at the boundary", async () => {
    const invalid = await prepareFlowQueryInput(["--unexpected"]);
    assert.equal(invalid.error.code, FLOW_QUERY_ERROR_CODES.INVALID_REQUEST);

    const requestPath = path.join(tmp = createTmpDir(), "request.json");
    fs.writeFileSync(requestPath, JSON.stringify({ resource: "metadata", condition: { specId: "001-query" } }));
    const both = spawnSync("node", [CLI, "flow", "query", "--request-file", requestPath], {
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      input: JSON.stringify({ resource: "metadata", condition: { specId: "001-query" } }),
      encoding: "utf8",
    });
    assert.equal(both.status, 1);
    assert.equal(JSON.parse(both.stdout).error.code, FLOW_QUERY_ERROR_CODES.INVALID_REQUEST);
  });

  it("keeps QueryRequest as the typed input boundary", () => {
    assert.equal(new QueryRequest({ resource: "metadata", condition: { specId: "001-query" } }).resource, "metadata");
    const defaultPage = new QueryRequest({ resource: "activities", condition: { specId: "001-query" } }).page;
    assert.equal(defaultPage.limit, 100);
    assert.equal(defaultPage.after, null);
    assert.throws(
      () => new QueryRequest({ resource: "metadata", condition: { specId: "001-query" }, page: {} }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page",
    );
    assert.throws(
      () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit: 1 } }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page",
    );
    for (const limit of [0, 101, 1.5]) {
      assert.throws(
        () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit, after: null } }),
        (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page/limit",
      );
    }
  });

  it("preserves the decoding cause when rejecting a malformed cursor", () => {
    const request = new QueryRequest({ resource: "activities", condition: { specId: "001-query" } });
    assert.throws(
      () => Cursor.decode("!", request),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_CURSOR && error.cause instanceof Error,
    );
  });

  it("preserves an own __proto__ key in canonical digest input", () => {
    const value = Object.create(null);
    Object.defineProperty(value, "__proto__", { value: "kept", enumerable: true, writable: true, configurable: true });
    value.resource = "activities";
    const canonical = Cursor.canonicalJson(value);
    assert.equal(canonical, '{"__proto__":"kept","resource":"activities"}');
    assert.equal(
      Cursor.digest(value),
      crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });

  it("distinguishes cursor tampering from query binding mismatch", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const request = {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 1, after: null },
    };
    const first = query(fixture.env, request);
    const tampered = `${first.pageInfo.endCursor.slice(0, -1)}${first.pageInfo.endCursor.endsWith("A") ? "B" : "A"}`;
    const malformed = query(fixture.env, { ...request, page: { limit: 1, after: tampered } });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, FLOW_QUERY_ERROR_CODES.INVALID_CURSOR);
    assert.equal(malformed.error.path, "/page/after");

    const mismatch = query(fixture.env, {
      ...request,
      recordedAt: { gte: "2000-01-01T00:00:00Z", lt: null },
      page: { limit: 1, after: first.pageInfo.endCursor },
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, FLOW_QUERY_ERROR_CODES.CURSOR_QUERY_MISMATCH);
    assert.equal(mismatch.error.path, "/page/after");
  });

  it("covers fresh lifecycle variants and preserves the canonical Git snapshot", () => {
    const cases = [
      { lifecycle: "active", git: false, expectedLifecycle: "active", blocked: false },
      { lifecycle: "parked", git: false, expectedLifecycle: "parked", blocked: false },
      { lifecycle: "blocked", git: true, expectedLifecycle: "active", blocked: true },
      { lifecycle: "finalized", git: true, expectedLifecycle: "finalized", blocked: false },
    ];
    for (const testCase of cases) {
      const fixture = contractFixture(testCase);
      const before = fixture.snapshot();
      const response = queryFixture(fixture, fixture.request());
      const after = fixture.snapshot();
      assert.equal(response.ok, true);
      assert.deepEqual(response.availableFlowVersions, [1]);
      assert.equal(response.item.lifecycle.lifecycle, testCase.expectedLifecycle);
      assert.equal(response.item.lifecycle.blocked, testCase.blocked);
      if (testCase.blocked) {
        assert.deepEqual(response.item.lifecycle.blocker, {
          code: "QUERY_FIXTURE_PROVIDER_UNAVAILABLE",
          message: "Deterministic query fixture failure.",
        });
        assert.equal(response.item.lifecycle.nextAction.operation, "blocked");
      } else {
        assert.equal(response.item.lifecycle.blocker, null);
      }
      assert.equal(response.item.location.git.available, testCase.git);
      assert.equal(testCase.git, response.item.location.git.commit !== null);
      if (testCase.git) assert.match(response.item.location.git.commit, /^[a-f0-9]{40}$/);
      else assert.equal(response.item.location.git.commit, null);
      assert.deepEqual(after, before);
      if (testCase.lifecycle === "finalized") {
        assert.deepEqual(queryFixture(fixture, fixture.request()), response);
      }
    }
  });

  it("uses the same reader for migrated direct records and Version 2 envelopes", () => {
    const fixture = contractFixture({ storage: "migrated", selectedVersion: 2 });
    const before = fixture.snapshot();
    const stateEnvelope = JSON.parse(fs.readFileSync(fixture.locations[2].flowStateFile, "utf8"));
    const specEnvelope = JSON.parse(fs.readFileSync(fixture.locations[2].specFile, "utf8"));
    assert.deepEqual(Object.keys(stateEnvelope).sort(), ["flowVersion", "recordRevision", "specId", "state"].sort());
    assert.deepEqual(Object.keys(specEnvelope).sort(), ["content", "recordRevision", "specId"].sort());
    assert.equal(stateEnvelope.recordRevision, 1);
    assert.equal(stateEnvelope.flowVersion, 2);
    assert.equal(stateEnvelope.state.flowVersion, 2);
    assert.equal(stateEnvelope.state.schemaRevision, 3);
    assert.equal(stateEnvelope.state.version, 1);
    assert.equal(specEnvelope.recordRevision, 1);
    const ledgerActivity = JSON.parse(fs.readFileSync(fixture.locations[2].activitiesFile, "utf8").split("\n")[0]);
    assert.deepEqual(Object.keys(ledgerActivity).sort(), [
      "attemptId", "confirmationOrder", "effort", "failure", "id", "metric", "model", "nodeId",
      "nodeKey", "note", "provider", "references", "result", "reviewPublication", "sequence", "timing",
      "transition", "type", "usage",
    ].sort());
    const catalog = JSON.parse(fs.readFileSync(fixture.locations[2].catalogFile, "utf8"));
    assert.equal(catalog.schemaRevision, 2);
    const versionOne = queryFixture(fixture, {
      resource: "metadata",
      condition: { specId: fixture.specId, flowVersion: 1 },
    });
    const versionTwo = queryFixture(fixture, fixture.request());
    assert.deepEqual(versionOne.availableFlowVersions, [1, 2]);
    assert.deepEqual(versionTwo.availableFlowVersions, [1, 2]);
    assert.deepEqual(versionOne.selectedFlowVersion, { specId: fixture.specId, flowVersion: 1 });
    assert.deepEqual(versionTwo.selectedFlowVersion, { specId: fixture.specId, flowVersion: 2 });
    assert.equal(versionOne.item.timestamps.createdAt.availability, "unavailable");
    assert.equal(versionOne.item.timestamps.createdAt.value, null);
    assert.equal(versionOne.item.timestamps.createdAt.reason.length > 0, true);
    assert.equal(versionOne.item.timestamps.createdAt.provenance, "confirmed-activity-prefix");
    assert.deepEqual(versionOne.item.timestamps.createdAt, {
      value: null,
      availability: "unavailable",
      reason: versionOne.item.timestamps.createdAt.reason,
      provenance: "confirmed-activity-prefix",
    });
    assert.ok(versionTwo.item.artifacts.some((artifact) => artifact.metadata.logicalKey === null));
    assert.deepEqual(fixture.snapshot(), before);
  });

  it("lets a Workspace/Connector consumer round-trip every public success fixture", () => {
    const consumer = new FlowQueryConsumer();
    const cases = [
      { options: { lifecycle: "active" }, resource: "metadata" },
      { options: { lifecycle: "parked" }, resource: "metadata" },
      { options: { lifecycle: "blocked" }, resource: "metadata" },
      { options: { lifecycle: "finalized" }, resource: "metadata" },
      { options: { storage: "migrated", selectedVersion: 2 }, resource: "metadata" },
      { options: { lifecycle: "active" }, resource: "activities" },
      { options: { lifecycle: "finalized" }, resource: "activities" },
      { options: { storage: "migrated", selectedVersion: 2 }, resource: "activities" },
    ];

    for (const testCase of cases) {
      const fixture = contractFixture(testCase.options);
      const result = runQuery(fixture, fixture.request(testCase.resource));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split("\n").length, 1);
      const response = JSON.parse(result.stdout);
      const consumed = consumer.consumeSerialized(result.stdout);
      assert.equal(response.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
      assert.equal(consumed.resource, testCase.resource);
      assert.deepEqual(consumed.selectedFlowVersion, response.selectedFlowVersion);
      assert.deepEqual(consumed.availableFlowVersions, response.availableFlowVersions);
      if (testCase.resource === "metadata") {
        assert.notEqual(consumed.item, null);
        assert.deepEqual(consumed.item, response.item);
        assert.equal(consumed.items, null);
        assert.equal(consumed.pageInfo, null);
        assert.equal(Object.hasOwn(response, "items"), false);
      } else {
        assert.equal(consumed.item, null);
        assert.ok(Array.isArray(consumed.items));
        assert.equal(consumed.pageInfo.limit, 100);
        assert.equal(Object.hasOwn(response, "item"), false);
      }
      assertNoInternalFields(response);
    }
  });

  it("lets a Workspace/Connector consumer round-trip bounded Activity pages and filters", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const consumer = new FlowQueryConsumer();
    const request = {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 1, after: null },
    };
    const firstResult = runQuery(fixture, request);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const firstResponse = JSON.parse(firstResult.stdout);
    const firstConsumed = consumer.consumeSerialized(firstResult.stdout);
    assert.deepEqual(firstConsumed.selectedFlowVersion, firstResponse.selectedFlowVersion);
    assert.deepEqual(firstConsumed.availableFlowVersions, firstResponse.availableFlowVersions);
    assert.deepEqual(firstConsumed.items, firstResponse.items);
    assert.deepEqual(firstConsumed.pageInfo, firstResponse.pageInfo);
    assert.equal(firstConsumed.pageInfo.limit, 1);
    assert.equal(firstConsumed.pageInfo.hasNext, true);

    const continuationResult = runQuery(fixture, {
      ...request,
      page: { limit: 1, after: firstResponse.pageInfo.endCursor },
    });
    assert.equal(continuationResult.status, 0, continuationResult.stderr);
    const continuationResponse = JSON.parse(continuationResult.stdout);
    const continuationConsumed = consumer.consumeSerialized(continuationResult.stdout);
    assert.deepEqual(continuationConsumed.items, continuationResponse.items);
    assert.deepEqual(continuationConsumed.pageInfo, continuationResponse.pageInfo);
    assert.equal(continuationConsumed.items[0].confirmationOrder, firstConsumed.items[0].confirmationOrder + 1);

    const fullResponse = JSON.parse(runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 100, after: null },
    }).stdout);
    assert.equal(fullResponse.ok, true);
    assert.equal(fullResponse.selectedFlowVersion.flowVersion, 1);
    assert.deepEqual(fullResponse.availableFlowVersions, [1]);
    const firstFinishedAt = fullResponse.items[0].timing.finishedAt;
    const inclusiveResult = runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      recordedAt: { gte: firstFinishedAt, lt: null },
    });
    assert.equal(inclusiveResult.status, 0, inclusiveResult.stderr);
    const inclusiveConsumed = consumer.consumeSerialized(inclusiveResult.stdout);
    assert.equal(inclusiveConsumed.items[0].confirmationOrder, 1);

    const exclusiveResult = runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      recordedAt: { gte: null, lt: firstFinishedAt },
    });
    assert.equal(exclusiveResult.status, 0, exclusiveResult.stderr);
    const exclusiveConsumed = consumer.consumeSerialized(exclusiveResult.stdout);
    assert.equal(exclusiveConsumed.items.some((item) => item.confirmationOrder === 1), false);

    const zeroMatchResult = runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      recordedAt: { gte: new Date(Date.parse(firstFinishedAt) + 1).toISOString(), lt: null },
    });
    assert.equal(zeroMatchResult.status, 0, zeroMatchResult.stderr);
    const zeroMatchConsumed = consumer.consumeSerialized(zeroMatchResult.stdout);
    assert.deepEqual(zeroMatchConsumed.items, []);
    assert.deepEqual(zeroMatchConsumed.pageInfo, JSON.parse(zeroMatchResult.stdout).pageInfo);
  });

  it("rejects a response revision the consumer does not support", () => {
    const fixture = contractFixture();
    const response = JSON.parse(runQuery(fixture, fixture.request()).stdout);
    const consumer = new FlowQueryConsumer();
    assert.doesNotThrow(() => consumer.consume(response));
    assert.throws(
      () => consumer.consume({ ...response, schemaRevision: FLOW_QUERY_SCHEMA_REVISION + 1 }),
      /unsupported query schema revision/,
    );

    const activities = JSON.parse(runQuery(fixture, fixture.request("activities")).stdout);
    assert.throws(
      () => consumer.consume({
        ...activities,
        pageInfo: { ...activities.pageInfo, limit: null },
      }),
      /pageInfo is invalid/,
    );

    assert.throws(
      () => consumer.consume({
        ...response,
        item: {
          ...response.item,
          relationships: {
            ...response.item.relationships,
            issues: [{ number: 1, relationship: "tracks" }, { number: 2, relationship: "tracks" }],
          },
        },
      }),
      /zero or one issue/,
    );
  });

  it("round-trips every known-resource error through the shared error enum", () => {
    const consumer = new FlowQueryConsumer();
    const cases = [
      {
        name: "metadata invalid request",
        request: (fixture) => null,
        input: (fixture) => JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId }, extra: true }),
        code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST,
        resource: "metadata",
        jsonPath: "/extra",
      },
      {
        name: "activities invalid request",
        request: (fixture) => null,
        input: (fixture) => JSON.stringify({ resource: "activities", condition: { specId: fixture.specId }, page: {} }),
        code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST,
        resource: "activities",
        jsonPath: "/page",
      },
      {
        name: "metadata missing Spec",
        request: (fixture) => ({ resource: "metadata", condition: { specId: "002-query-fixture-missing" } }),
        code: FLOW_QUERY_ERROR_CODES.SPEC_NOT_FOUND,
        resource: "metadata",
        jsonPath: "/condition/specId",
      },
      {
        name: "activities missing Spec",
        request: (fixture) => ({ resource: "activities", condition: { specId: "002-query-fixture-missing" } }),
        code: FLOW_QUERY_ERROR_CODES.SPEC_NOT_FOUND,
        resource: "activities",
        pageLimit: 100,
        jsonPath: "/condition/specId",
      },
      {
        name: "metadata missing Version",
        request: (fixture) => ({ resource: "metadata", condition: { specId: fixture.specId, flowVersion: 2 } }),
        code: FLOW_QUERY_ERROR_CODES.FLOW_VERSION_NOT_FOUND,
        resource: "metadata",
        jsonPath: "/condition/flowVersion",
      },
      {
        name: "activities missing Version",
        request: (fixture) => ({ resource: "activities", condition: { specId: fixture.specId, flowVersion: 2 } }),
        code: FLOW_QUERY_ERROR_CODES.FLOW_VERSION_NOT_FOUND,
        resource: "activities",
        pageLimit: 100,
        jsonPath: "/condition/flowVersion",
      },
      {
        name: "metadata unreadable canonical record",
        request: (fixture) => fixture.request("metadata"),
        mutate: (fixture) => fs.unlinkSync(fixture.locations[1].specFile),
        code: FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
        resource: "metadata",
        jsonPath: "/canonical",
      },
      {
        name: "activities unreadable canonical record",
        request: (fixture) => fixture.request("activities"),
        mutate: (fixture) => fs.unlinkSync(fixture.locations[1].specFile),
        code: FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE,
        resource: "activities",
        pageLimit: 100,
        jsonPath: "/canonical",
      },
      {
        name: "metadata inconsistent canonical record",
        request: (fixture) => fixture.request("metadata"),
        mutate: (fixture) => {
          const file = fixture.locations[1].flowStateFile;
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.schemaRevision = 4;
          fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
        },
        code: FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
        resource: "metadata",
        jsonPath: "/canonical",
      },
      {
        name: "activities inconsistent canonical record",
        request: (fixture) => ({ resource: "activities", condition: { specId: fixture.specId }, page: { limit: 1, after: null } }),
        mutate: (fixture) => {
          const file = fixture.locations[1].activitiesFile;
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          const activity = JSON.parse(lines[0]);
          activity.confirmationOrder = 2;
          lines[0] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`);
        },
        code: FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
        resource: "activities",
        pageLimit: 1,
        jsonPath: "/canonical",
      },
    ];

    for (const testCase of cases) {
      const fixture = contractFixture();
      testCase.mutate?.(fixture);
      const request = testCase.request(fixture);
      const result = runQuery(fixture, request, testCase.input ? { input: testCase.input(fixture) } : {});
      assert.equal(result.status, 1, testCase.name);
      const response = JSON.parse(result.stdout);
      assertKnownResourceError(response, testCase.resource, testCase.code, testCase.jsonPath, {
        pageLimit: testCase.pageLimit ?? null,
      });
      const consumed = consumer.consumeSerialized(result.stdout);
      assert.equal(consumed.error.code, testCase.code, testCase.name);
      if ([FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, FLOW_QUERY_ERROR_CODES.SPEC_NOT_FOUND].includes(testCase.code)) {
        assert.equal(response.selectedFlowVersion, null, testCase.name);
        assert.deepEqual(response.availableFlowVersions, [], testCase.name);
      } else if (testCase.code === FLOW_QUERY_ERROR_CODES.FLOW_VERSION_NOT_FOUND) {
        assert.equal(response.selectedFlowVersion, null, testCase.name);
        assert.deepEqual(response.availableFlowVersions, [1], testCase.name);
      } else if ([FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE, FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT].includes(testCase.code)) {
        assert.equal(response.selectedFlowVersion, null, testCase.name);
        assert.deepEqual(response.availableFlowVersions, [], testCase.name);
      } else {
        assert.deepEqual(response.selectedFlowVersion, { specId: fixture.specId, flowVersion: 1 }, testCase.name);
        assert.deepEqual(response.availableFlowVersions, [1], testCase.name);
      }
    }

    const invalidJson = contractFixture();
    const invalidJsonResult = runQuery(invalidJson, null, { input: "not-json" });
    assert.equal(invalidJsonResult.status, 1);
    const invalidJsonResponse = JSON.parse(invalidJsonResult.stdout);
    const invalidJsonConsumed = consumer.consumeSerialized(invalidJsonResult.stdout);
    assert.equal(invalidJsonConsumed.resource, null);
    assert.equal(invalidJsonConsumed.error.code, FLOW_QUERY_ERROR_CODES.INVALID_JSON);
    assert.throws(
      () => consumer.consume({
        ...invalidJsonResponse,
        error: { ...invalidJsonResponse.error, path: "/canonical" },
      }),
      /query error is invalid/,
    );
  });

  it("round-trips cursor errors without exposing cursor internals", () => {
    const fixture = contractFixture({ lifecycle: "active" });
    const request = {
      resource: "activities",
      condition: { specId: fixture.specId },
      page: { limit: 1, after: null },
    };
    const first = query(fixture.env, request);
    const tampered = `${first.pageInfo.endCursor.slice(0, -1)}${first.pageInfo.endCursor.endsWith("A") ? "B" : "A"}`;
    const invalid = runQuery(fixture, { ...request, page: { limit: 1, after: tampered } });
    assert.equal(invalid.status, 1);
    const invalidResponse = JSON.parse(invalid.stdout);
    assertKnownResourceError(invalidResponse, "activities", FLOW_QUERY_ERROR_CODES.INVALID_CURSOR, "/page/after");
    assert.equal(consumer.consumeSerialized(invalid.stdout).error.code, FLOW_QUERY_ERROR_CODES.INVALID_CURSOR);
    assert.equal(invalidResponse.selectedFlowVersion, null);
    assert.deepEqual(invalidResponse.availableFlowVersions, []);

    const mismatch = runQuery(fixture, {
      ...request,
      recordedAt: { gte: "2000-01-01T00:00:00Z", lt: null },
      page: { limit: 1, after: first.pageInfo.endCursor },
    });
    assert.equal(mismatch.status, 1);
    const mismatchResponse = JSON.parse(mismatch.stdout);
    assertKnownResourceError(mismatchResponse, "activities", FLOW_QUERY_ERROR_CODES.CURSOR_QUERY_MISMATCH, "/page/after", { pageLimit: 1 });
    assert.equal(consumer.consumeSerialized(mismatch.stdout).error.code, FLOW_QUERY_ERROR_CODES.CURSOR_QUERY_MISMATCH);
    assert.equal(mismatchResponse.selectedFlowVersion, null);
    assert.deepEqual(mismatchResponse.availableFlowVersions, []);
  });

  it("projects exact artifact descriptors and catalog Activity relations", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const response = query(fixture.env, fixture.request);
    const catalog = JSON.parse(fs.readFileSync(fixture.flow.location().catalogFile, "utf8"));
    const activities = fixture.flowManager.activityLedger("001-query");
    const associated = catalog.artifacts.find((descriptor) => descriptor.activityId !== null && descriptor.logicalKey === "task.mutation.lineage");
    assert.ok(associated);
    const activity = activities.find((entry) => entry.id === associated.activityId);
    assert.ok(activity);
    const projected = response.item.artifacts.find((artifact) => artifact.artifactId === expectedArtifactId(associated));
    assert.ok(projected);
    assert.deepEqual(Object.keys(projected).sort(), ["activityIds", "artifactId", "metadata", "nodeIds", "taskIds"].sort());
    assert.deepEqual(Object.keys(projected.metadata).sort(), ["logicalKey", "mediaType", "schemaRevision"].sort());
    assert.equal(projected.metadata.logicalKey, associated.logicalKey);
    assert.equal(projected.metadata.mediaType, associated.mediaType);
    assert.equal(projected.metadata.schemaRevision, null);
    assert.deepEqual(projected.activityIds, [associated.activityId]);
    assert.deepEqual(projected.nodeIds, [activity.nodeId]);
    assert.deepEqual(projected.taskIds, ["T-1"]);
    assert.equal(new Set(projected.activityIds).size, projected.activityIds.length);
    assert.equal(new Set(projected.nodeIds).size, projected.nodeIds.length);
    assert.equal(new Set(projected.taskIds).size, projected.taskIds.length);
  });

  it("rejects every unsupported canonical authority revision", () => {
    const cases = [
      {
        name: "state schema revision",
        fixture: () => contractFixture(),
        mutate: (fixture) => {
          const file = fixture.locations[1].flowStateFile;
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.schemaRevision = 4;
          fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
        },
      },
      {
        name: "state result version",
        fixture: () => contractFixture(),
        mutate: (fixture) => {
          const file = fixture.locations[1].flowStateFile;
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.version = 2;
          fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
        },
      },
      {
        name: "Versioned state record envelope",
        fixture: () => contractFixture({ storage: "migrated", selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].flowStateFile;
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.recordRevision = 2;
          fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
        },
      },
      {
        name: "Versioned Spec record envelope",
        fixture: () => contractFixture({ storage: "migrated", selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].specFile;
          const spec = JSON.parse(fs.readFileSync(file, "utf8"));
          spec.recordRevision = 2;
          fs.writeFileSync(file, `${JSON.stringify(spec)}\n`);
        },
      },
      {
        name: "FlowActivity ledger format",
        fixture: () => contractFixture({ storage: "migrated", selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].activitiesFile;
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          const activity = JSON.parse(lines[0]);
          activity.formatRevision = 2;
          lines[0] = JSON.stringify(activity);
          fs.writeFileSync(file, `${lines.join("\n")}\n`);
        },
      },
      {
        name: "FlowArtifactCatalog schema revision",
        fixture: () => contractFixture({ storage: "migrated", selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].catalogFile;
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.schemaRevision = 3;
          fs.writeFileSync(file, `${JSON.stringify(catalog)}\n`);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = testCase.fixture();
      testCase.mutate(fixture);
      const before = fixture.snapshot();
      const result = runQuery(fixture, fixture.request());
      assert.equal(result.status, 1, testCase.name);
      assertKnownResourceError(
        JSON.parse(result.stdout),
        "metadata",
        FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
        "/canonical",
      );
      assert.deepEqual(fixture.snapshot(), before, testCase.name);
    }
  });

  it("classifies missing records, identity mismatch, and catalog revision errors as canonical errors", () => {
    const missing = contractFixture();
    fs.unlinkSync(missing.locations[1].specFile);
    const missingBefore = missing.snapshot();
    const missingResult = runQuery(missing, missing.request());
    assert.equal(missingResult.status, 1);
    assertKnownResourceError(JSON.parse(missingResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical");
    assert.deepEqual(missing.snapshot(), missingBefore);

    const missingArtifact = contractFixture();
    const artifactCatalog = JSON.parse(fs.readFileSync(missingArtifact.locations[1].catalogFile, "utf8"));
    const catalogedArtifact = artifactCatalog.artifacts.find((artifact) => artifact.relativePath === "revisions/001/spec.json");
    assert.ok(catalogedArtifact);
    fs.unlinkSync(missingArtifact.locations[1].resolve(catalogedArtifact.relativePath));
    const missingArtifactBefore = missingArtifact.snapshot();
    const missingArtifactResult = runQuery(missingArtifact, missingArtifact.request());
    assert.equal(missingArtifactResult.status, 1);
    assertKnownResourceError(JSON.parse(missingArtifactResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical");
    assert.deepEqual(missingArtifact.snapshot(), missingArtifactBefore);

    const catalog = contractFixture();
    const catalogValue = JSON.parse(fs.readFileSync(catalog.locations[1].catalogFile, "utf8"));
    catalogValue.schemaRevision = 1;
    fs.writeFileSync(catalog.locations[1].catalogFile, `${JSON.stringify(catalogValue)}\n`);
    const catalogBefore = catalog.snapshot();
    const catalogResult = runQuery(catalog, catalog.request());
    assert.equal(catalogResult.status, 1);
    assertKnownResourceError(JSON.parse(catalogResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(catalog.snapshot(), catalogBefore);

    const identity = contractFixture({ storage: "fresh", selectedVersion: 2 });
    const stateFile = identity.locations[2].flowStateFile;
    const stateEnvelope = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    stateEnvelope.flowVersion = 3;
    fs.writeFileSync(stateFile, `${JSON.stringify(stateEnvelope)}\n`);
    const identityBefore = identity.snapshot();
    const identityResult = runQuery(identity, identity.request());
    assert.equal(identityResult.status, 1);
    const identityResponse = JSON.parse(identityResult.stdout);
    assertKnownResourceError(identityResponse, "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.equal(identityResponse.selectedFlowVersion, null);
    assert.deepEqual(identityResponse.availableFlowVersions, []);
    assert.deepEqual(identity.snapshot(), identityBefore);

    const oversized = contractFixture();
    fs.writeFileSync(oversized.locations[1].flowStateFile, Buffer.alloc(queryFixtureLimits().MAX_STATE_RECORD_BYTES + 1, 0x20));
    const oversizedBefore = oversized.snapshot();
    const oversizedResult = runQuery(oversized, oversized.request());
    assert.equal(oversizedResult.status, 1);
    assertKnownResourceError(JSON.parse(oversizedResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(oversized.snapshot(), oversizedBefore);
  });

  it("classifies a discontinuous confirmed ledger with the activities error envelope", () => {
    const fixture = contractFixture();
    const location = fixture.locations[1];
    const ledger = fs.readFileSync(location.activitiesFile, "utf8").trimEnd().split("\n");
    const first = JSON.parse(ledger[0]);
    first.confirmationOrder = 2;
    ledger[0] = JSON.stringify(first);
    fs.writeFileSync(location.activitiesFile, `${ledger.join("\n")}\n`);
    const before = fixture.snapshot();

    const result = runQuery(fixture, {
      resource: "activities",
      condition: { specId: fixture.specId },
      page: { limit: 1, after: null },
    });
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", { pageLimit: 1 });
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it("rejects bounded canonical inputs without truncating the available Version set or ledger", () => {
    const versions = contractFixture();
    const versionRoot = path.dirname(versions.locations[1].directory);
    for (let version = 2; version <= queryFixtureLimits().MAX_AVAILABLE_FLOW_VERSIONS + 1; version += 1) {
      fs.mkdirSync(path.join(versionRoot, String(version)));
    }
    const versionsBefore = versions.snapshot();
    const versionsResult = runQuery(versions, versions.request());
    assert.equal(versionsResult.status, 1);
    assertKnownResourceError(JSON.parse(versionsResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(versions.snapshot(), versionsBefore);

    const symlinkVersion = contractFixture();
    const symlinkVersionRoot = path.dirname(symlinkVersion.locations[1].directory);
    fs.symlinkSync(symlinkVersion.locations[1].directory, path.join(symlinkVersionRoot, "2"), "dir");
    const symlinkResult = runQuery(symlinkVersion, symlinkVersion.request());
    assert.equal(symlinkResult.status, 1);
    const symlinkResponse = JSON.parse(symlinkResult.stdout);
    assertKnownResourceError(symlinkResponse, "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.equal(symlinkResponse.selectedFlowVersion, null);
    assert.deepEqual(symlinkResponse.availableFlowVersions, []);

    const ledger = contractFixture();
    fs.writeFileSync(
      ledger.locations[1].activitiesFile,
      Buffer.alloc(queryFixtureLimits().MAX_CONFIRMED_LEDGER_BYTES + 1, 0x20),
    );
    const ledgerBefore = ledger.snapshot();
    const ledgerResult = runQuery(ledger, {
      resource: "activities",
      condition: { specId: ledger.specId },
      page: { limit: 1, after: null },
    });
    assert.equal(ledgerResult.status, 1);
    assertKnownResourceError(JSON.parse(ledgerResult.stdout), "activities", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical", { pageLimit: 1 });
    assert.deepEqual(ledger.snapshot(), ledgerBefore);
  });

  it("keeps request-file, boundary, resource-shape, and bounded-input fixtures explicit", () => {
    const fixture = contractFixture();
    const requestPath = path.join(fixture.root, "query-request.json");
    fs.writeFileSync(requestPath, `${JSON.stringify(fixture.request())}\n`);
    const before = fixture.snapshot();
    const fromFile = runQuery(fixture, null, { args: ["--request-file", requestPath], input: "" });
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.equal(JSON.parse(fromFile.stdout).ok, true);

    const cases = [
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId }, unexpected: true }),
        resource: "metadata", code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/unexpected",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId, unexpected: true } }),
        resource: "metadata", code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/condition/unexpected",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId }, page: {} }),
        resource: "metadata", code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/page",
      },
      {
        input: JSON.stringify({ resource: "activities", condition: { specId: fixture.specId }, recordedAt: {} }),
        resource: "activities", code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/recordedAt",
      },
      {
        input: JSON.stringify({ resource: "unknown", condition: { specId: fixture.specId } }),
        resource: null, code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/resource",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId } }) + " trailing",
        resource: null, code: FLOW_QUERY_ERROR_CODES.INVALID_JSON, path: "/request",
      },
      { input: "", resource: null, code: FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, path: "/request" },
      { input: "{} {}", resource: null, code: FLOW_QUERY_ERROR_CODES.INVALID_JSON, path: "/request" },
    ];
    for (const testCase of cases) {
      const result = runQuery(fixture, null, { input: testCase.input });
      assert.equal(result.status, 1);
      const response = JSON.parse(result.stdout);
      const consumed = new FlowQueryConsumer().consume(response);
      if (testCase.resource === null) {
        assert.deepEqual(Object.keys(response).sort(), ["error", "ok", "schemaRevision"].sort());
        assert.equal(response.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
        assert.equal(response.ok, false);
        assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path"]);
        assert.equal(response.error.code, testCase.code);
        assert.equal(response.error.path, testCase.path);
        assert.equal(consumed.resource, null);
      } else {
        assertKnownResourceError(response, testCase.resource, testCase.code, testCase.path);
        assert.equal(consumed.resource, testCase.resource);
      }
      assert.equal(result.stderr.trim().split("\n").length, 1);
    }

    const oversized = runQuery(fixture, null, {
      input: JSON.stringify({
        resource: "metadata",
        condition: { specId: fixture.specId },
        field: "x".repeat(queryFixtureLimits().MAX_REQUEST_BYTES),
      }),
    });
    assert.equal(oversized.status, 1);
    const oversizedResponse = JSON.parse(oversized.stdout);
    assert.equal(oversizedResponse.error.code, FLOW_QUERY_ERROR_CODES.INVALID_REQUEST);
    assert.equal(oversizedResponse.error.path, "/request");
    assert.deepEqual(fixture.snapshot(), before);
  });
});
