import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { createFlowQueryFixture, queryFixtureLimits } from "../../support/builders/flow-query-fixture.js";
import { Cursor, prepareFlowQueryInput, QueryRequest } from "../../../src/flow/query.js";

const CLI = path.join(process.cwd(), "src/sennel.js");

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
    assert.deepEqual(Object.keys(response).sort(), [
      "availableFlowVersions", "error", "ok", "resource", "schemaRevision", "selectedFlowVersion",
      ...(resource === "metadata" ? ["item"] : ["items", "pageInfo"]),
    ].sort());
    assert.equal(response.schemaRevision, 1);
    assert.equal(response.ok, false);
    assert.equal(response.resource, resource);
    assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path"]);
    assert.equal(response.error.code, code);
    assert.equal(response.error.path, jsonPath);
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
    return JSON.parse(execFileSync("node", [CLI, "flow", "query"], {
      env,
      input: JSON.stringify(request),
      encoding: "utf8",
    }));
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
    assert.deepEqual(orders, [...new Set(orders)].sort((left, right) => left - right));
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
    assert.equal(invalid.error.code, "INVALID_REQUEST");

    const requestPath = path.join(tmp = createTmpDir(), "request.json");
    fs.writeFileSync(requestPath, JSON.stringify({ resource: "metadata", condition: { specId: "001-query" } }));
    const both = spawnSync("node", [CLI, "flow", "query", "--request-file", requestPath], {
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      input: JSON.stringify({ resource: "metadata", condition: { specId: "001-query" } }),
      encoding: "utf8",
    });
    assert.equal(both.status, 1);
    assert.equal(JSON.parse(both.stdout).error.code, "INVALID_REQUEST");
  });

  it("keeps QueryRequest as the typed input boundary", () => {
    assert.equal(new QueryRequest({ resource: "metadata", condition: { specId: "001-query" } }).resource, "metadata");
    const defaultPage = new QueryRequest({ resource: "activities", condition: { specId: "001-query" } }).page;
    assert.equal(defaultPage.limit, 100);
    assert.equal(defaultPage.after, null);
    assert.throws(
      () => new QueryRequest({ resource: "metadata", condition: { specId: "001-query" }, page: {} }),
      (error) => error.code === "INVALID_REQUEST" && error.jsonPath === "/page",
    );
    assert.throws(
      () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit: 1 } }),
      (error) => error.code === "INVALID_REQUEST" && error.jsonPath === "/page",
    );
    for (const limit of [0, 101, 1.5]) {
      assert.throws(
        () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit, after: null } }),
        (error) => error.code === "INVALID_REQUEST" && error.jsonPath === "/page/limit",
      );
    }
  });

  it("preserves the decoding cause when rejecting a malformed cursor", () => {
    const request = new QueryRequest({ resource: "activities", condition: { specId: "001-query" } });
    assert.throws(
      () => Cursor.decode("!", request),
      (error) => error.code === "INVALID_CURSOR" && error.cause instanceof Error,
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
    assert.equal(malformed.error.code, "INVALID_CURSOR");
    assert.equal(malformed.error.path, "/page/after");

    const mismatch = query(fixture.env, {
      ...request,
      recordedAt: { gte: "2000-01-01T00:00:00Z", lt: null },
      page: { limit: 1, after: first.pageInfo.endCursor },
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, "CURSOR_QUERY_MISMATCH");
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
    assert.equal(specEnvelope.recordRevision, 1);
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
    assert.equal(versionOne.item.timestamps.createdAt.provenance, "confirmed-activity-prefix");
    assert.ok(versionTwo.item.artifacts.some((artifact) => artifact.metadata.logicalKey === null));
    assert.deepEqual(fixture.snapshot(), before);
  });

  it("classifies missing records, identity mismatch, and catalog revision errors as canonical errors", () => {
    const missing = contractFixture();
    fs.unlinkSync(missing.locations[1].specFile);
    const missingBefore = missing.snapshot();
    const missingResult = runQuery(missing, missing.request());
    assert.equal(missingResult.status, 1);
    assertKnownResourceError(JSON.parse(missingResult.stdout), "metadata", "CANONICAL_RECORD_UNREADABLE", "/canonical");
    assert.deepEqual(missing.snapshot(), missingBefore);

    const catalog = contractFixture();
    const catalogValue = JSON.parse(fs.readFileSync(catalog.locations[1].catalogFile, "utf8"));
    catalogValue.schemaRevision = 1;
    fs.writeFileSync(catalog.locations[1].catalogFile, `${JSON.stringify(catalogValue)}\n`);
    const catalogBefore = catalog.snapshot();
    const catalogResult = runQuery(catalog, catalog.request());
    assert.equal(catalogResult.status, 1);
    assertKnownResourceError(JSON.parse(catalogResult.stdout), "metadata", "CANONICAL_RECORD_INCONSISTENT", "/canonical");
    assert.deepEqual(catalog.snapshot(), catalogBefore);

    const identity = contractFixture({ storage: "fresh", selectedVersion: 2 });
    const stateFile = identity.locations[2].flowStateFile;
    const stateEnvelope = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    stateEnvelope.flowVersion = 3;
    fs.writeFileSync(stateFile, `${JSON.stringify(stateEnvelope)}\n`);
    const identityBefore = identity.snapshot();
    const identityResult = runQuery(identity, identity.request());
    assert.equal(identityResult.status, 1);
    assertKnownResourceError(JSON.parse(identityResult.stdout), "metadata", "CANONICAL_RECORD_INCONSISTENT", "/canonical");
    assert.deepEqual(identity.snapshot(), identityBefore);

    const oversized = contractFixture();
    fs.writeFileSync(oversized.locations[1].flowStateFile, Buffer.alloc(queryFixtureLimits().MAX_STATE_RECORD_BYTES + 1, 0x20));
    const oversizedBefore = oversized.snapshot();
    const oversizedResult = runQuery(oversized, oversized.request());
    assert.equal(oversizedResult.status, 1);
    assertKnownResourceError(JSON.parse(oversizedResult.stdout), "metadata", "CANONICAL_RECORD_INCONSISTENT", "/canonical");
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
    assertKnownResourceError(response, "activities", "CANONICAL_RECORD_INCONSISTENT", "/canonical", { pageLimit: 1 });
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
    assertKnownResourceError(JSON.parse(versionsResult.stdout), "metadata", "CANONICAL_RECORD_INCONSISTENT", "/canonical");
    assert.deepEqual(versions.snapshot(), versionsBefore);

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
    assertKnownResourceError(JSON.parse(ledgerResult.stdout), "activities", "CANONICAL_RECORD_INCONSISTENT", "/canonical", { pageLimit: 1 });
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
        resource: "metadata", code: "INVALID_REQUEST", path: "/unexpected",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId, unexpected: true } }),
        resource: "metadata", code: "INVALID_REQUEST", path: "/condition/unexpected",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId }, page: {} }),
        resource: "metadata", code: "INVALID_REQUEST", path: "/page",
      },
      {
        input: JSON.stringify({ resource: "activities", condition: { specId: fixture.specId }, recordedAt: {} }),
        resource: "activities", code: "INVALID_REQUEST", path: "/recordedAt",
      },
      {
        input: JSON.stringify({ resource: "unknown", condition: { specId: fixture.specId } }),
        resource: null, code: "INVALID_REQUEST", path: "/resource",
      },
      {
        input: JSON.stringify({ resource: "metadata", condition: { specId: fixture.specId } }) + " trailing",
        resource: null, code: "INVALID_JSON", path: "/request",
      },
      { input: "", resource: null, code: "INVALID_REQUEST", path: "/request" },
      { input: "{} {}", resource: null, code: "INVALID_JSON", path: "/request" },
    ];
    for (const testCase of cases) {
      const result = runQuery(fixture, null, { input: testCase.input });
      assert.equal(result.status, 1);
      const response = JSON.parse(result.stdout);
      if (testCase.resource === null) {
        assert.deepEqual(Object.keys(response).sort(), ["error", "ok", "schemaRevision"].sort());
        assert.equal(response.schemaRevision, 1);
        assert.equal(response.ok, false);
        assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path"]);
        assert.equal(response.error.code, testCase.code);
        assert.equal(response.error.path, testCase.path);
      } else {
        assertKnownResourceError(response, testCase.resource, testCase.code, testCase.path);
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
    assert.equal(oversizedResponse.error.code, "INVALID_REQUEST");
    assert.equal(oversizedResponse.error.path, "/request");
    assert.deepEqual(fixture.snapshot(), before);
  });
});
