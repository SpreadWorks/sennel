import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { describe, it, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { createFlowQueryScenarioFixture, queryFixtureLimits } from "../../support/builders/flow-query-fixture.js";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";
import {
  Cursor,
  FLOW_QUERY_ERROR_CODES,
  FLOW_QUERY_SCHEMA_REVISION,
  prepareFlowQueryInput,
  QueryRequest,
} from "../../../src/flow/query.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactSpecReviewActivityEvidenceDocument } from "../../../src/lib/flow-artifact-contract.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { captureGitSnapshot } from "../../../src/lib/git-helpers.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { CanonicalCommandResultPublication, attachCanonicalCommandResultArtifact, attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { completeCanonicalSourceHandoff } from "../../support/builders/source-handoff-scenario.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";

const CLI = path.join(process.cwd(), "src/sennel.js");
const DIRECT_FLOW_CLI = path.join(process.cwd(), "src/flow.js");

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
  const forbidden = new Set(["recordRevision", "catalog", "body", "checkpoint", "lock", "state", "receipt", "rawLog"]);
  const visit = (entry, location = "") => {
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) visit(entry[index], `${location}/${index}`);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, `public response leaked internal field: ${key}`);
      if (key === "relativePath") {
        assert.match(location, /^\/(?:item\/artifacts\/\d+|entities\/(?:evaluations|findings|repairs)\/\d+\/(?:source|supportingSources\/\d+))$/);
        assert.equal(path.posix.isAbsolute(child), false);
        assert.equal(child.split("/").includes(".."), false);
      }
      visit(child, `${location}/${key}`);
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

  async function contractFixture(options = {}) {
    const fixture = await createFlowQueryScenarioFixture(options);
    fixtureRoots.push(fixture.root);
    return fixture;
  }

  function runQuery(fixture, request, { input = JSON.stringify(request), args = [] } = {}) {
    return spawnSync(process.execPath, [CLI, "flow", "query", ...args], {
      cwd: fixture.root,
      env: fixture.env,
      input,
      encoding: "utf8",
      maxBuffer: queryFixtureLimits().MAX_RESPONSE_BYTES * 2,
    });
  }

  function queryFixture(fixture, request) {
    const result = runQuery(fixture, request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const response = JSON.parse(result.stdout);
    new FlowQueryConsumer().consumeSerialized(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), [
      "availableFlowVersions", "item", "ok", "resource", "schemaRevision", "selectedFlowVersion", "snapshot", "completeness",
    ].sort());
    assert.deepEqual(Object.keys(response.item).sort(), [
      "artifacts", "capabilities", "identity", "lifecycle", "location", "metrics",
      "relationships", "structure", "timestamps", "history",
    ].sort());
    return response;
  }

  function assertKnownResourceError(response, resource, code, jsonPath, { pageLimit = null } = {}) {
    const consumed = new FlowQueryConsumer().consume(response);
    assert.deepEqual(Object.keys(response).sort(), [
      "availableFlowVersions", "error", "guidance", "ok", "resource", "schemaRevision", "selectedFlowVersion", "snapshot", "completeness",
      ...(resource === "metadata" ? ["item"] : ["items", "pageInfo", "entities"]),
    ].sort());
    assert.equal(response.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
    assert.equal(response.ok, false);
    assert.equal(response.completeness, null);
    assert.equal(response.resource, resource);
    assert.equal(consumed.resource, resource);
    assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path", "reason", "referenceId"]);
    assert.equal(response.error.code, code);
    assert.equal(response.error.path, jsonPath);
    assert.equal(response.guidance.code, code);
    assert.deepEqual(consumed.guidance, response.guidance);
    assert.doesNotMatch(JSON.stringify(response.error), /flow\.json|artifact-catalog|\.runtime|lock/);
    assertNoInternalFields(response);
    if (resource === "metadata") assert.equal(response.item, null);
    else {
      assert.deepEqual(response.items, []);
      assert.deepEqual(response.pageInfo, { limit: pageLimit, endCursor: null, hasNext: false, returnedItems: 0, totalItems: null });
      assert.deepEqual(response.entities, { evaluations: [], findings: [], repairs: [] });
    }
  }

  function createFlow({ withTask = false, capabilities = null, git = false } = {}) {
    tmp = createTmpDir();
    setupFlowConfig(tmp, "en");
    if (git) {
      initGitRepo(tmp);
      commitAll(tmp, "query fixture baseline");
    }
    const flowManager = makeFlowManager(tmp);
    const flow = new CanonicalFlowFixture({
      flowManager,
      specId: "001-query",
      runId: "run-query",
      execution: { mode: "direct", baseBranch: git ? "main" : null },
      context: git ? { gitSnapshot: captureGitSnapshot(tmp) } : null,
      specRecord: {
        goal: "query fixture",
        ...(capabilities === null ? {} : { capabilities }),
        ...(withTask ? {
          requirements: [{ id: "R-1", desc: "Exercise the query fixture Task.", task_ids: ["T-1"] }],
        } : {}),
      },
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

  function activityRequestFrom(fixture, activity, { limit = 1 } = {}) {
    const specId = fixture.specId ?? fixture.request.condition.specId;
    const metadata = query(fixture.env, { resource: "metadata", condition: { specId } });
    const request = { resource: "activities", condition: { specId }, page: { limit, after: null } };
    if (activity.confirmationOrder > 1) request.page.after = new Cursor({
      request: new QueryRequest(request), order: activity.confirmationOrder - 1, snapshotId: metadata.snapshot.id,
    }).encode();
    return request;
  }

  function rewriteTaskResultReferenceKind(fixture, kind) {
    const location = fixture.flow.location();
    const state = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const locate = (node) => {
      if (node.id === "T-1-impl") return node;
      for (const child of node.steps ?? []) {
        const found = locate(child);
        if (found !== null) return found;
      }
      return null;
    };
    const taskStep = locate(state);
    assert.ok(taskStep?.result?.artifactRefs?.length > 0);
    taskStep.result.artifactRefs[0].kind = kind;
    fs.writeFileSync(location.flowStateFile, `${JSON.stringify(state)}\n`);

    const activities = fs.readFileSync(location.activitiesFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    const activity = activities.find((entry) => entry.nodeId === "T-1-impl" && entry.result?.artifactRefs?.length > 0);
    assert.ok(activity);
    activity.result.artifactRefs[0].kind = kind;
    fs.writeFileSync(location.activitiesFile, `${activities.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
    for (const relativePath of ["flow.json", "activities.jsonl"]) {
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
      assert.ok(descriptor);
      const bytes = fs.readFileSync(location.resolve(relativePath));
      descriptor.hash = crypto.createHash("sha256").update(bytes).digest("hex");
      descriptor.size = bytes.length;
    }
    fs.writeFileSync(location.catalogFile, `${JSON.stringify(new FlowArtifactCatalog({ artifacts: catalog.artifacts }).toJSON())}\n`);
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
    const directResponse = JSON.parse(execFileSync("node", [DIRECT_FLOW_CLI, "query"], {
      env: fixture.env,
      input: JSON.stringify(fixture.request),
      encoding: "utf8",
    }));
    assert.deepEqual({ ...directResponse, snapshot: { ...directResponse.snapshot, capturedAt: response.snapshot.capturedAt } }, response);
    assert.deepEqual(fs.readFileSync(path.join(tmp, "specs", "001-query", "001", "flow.json")), before);
  });

  it("flushes metadata responses larger than a stdout pipe buffer before exiting", () => {
    const capabilities = Object.fromEntries(Array.from(
      { length: 5_000 },
      (_, index) => [`Capability${String(index).padStart(4, "0")}`, index % 2 === 0],
    ));
    const fixture = createFlow({ capabilities });

    const result = spawnSync(process.execPath, [CLI, "flow", "query"], {
      env: fixture.env,
      input: JSON.stringify(fixture.request),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) > 64 * 1024);
    const response = JSON.parse(result.stdout);
    new FlowQueryConsumer().consume(response);
    assert.deepEqual(response.item.capabilities, capabilities);
  });

  it("reads an unbound query root without Git or worktree discovery", async () => {
    const fixture = await contractFixture();
    const bin = path.join(fixture.root, ".fixture-bin");
    const marker = path.join(fixture.root, "git-called");
    fs.mkdirSync(bin);
    const fakeGit = path.join(bin, "git");
    fs.writeFileSync(fakeGit, "#!/usr/bin/env node\nimport { writeFileSync } from \"node:fs\";\nwriteFileSync(process.env.SENNEL_QUERY_GIT_MARKER, \"called\\n\");\nprocess.stderr.write(\"unexpected git invocation\\n\");\nprocess.exit(1);\n");
    fs.chmodSync(fakeGit, 0o755);
    const env = { ...fixture.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SENNEL_QUERY_GIT_MARKER: marker };
    delete env.SENNEL_WORK_ROOT;
    delete env.SENNEL_SOURCE_ROOT;

    const result = spawnSync(process.execPath, [CLI, "flow", "query"], {
      cwd: fixture.root,
      env,
      input: JSON.stringify(fixture.request()),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.doesNotMatch(result.stderr, /git|not a git repository/i);
  });

  it("honors the bound work root and its configured Spec directory independently of cwd", async () => {
    const fixture = await contractFixture();
    const configuredSpecRoot = "canonical-flow-versions";
    fs.renameSync(path.join(fixture.root, "specs"), path.join(fixture.root, configuredSpecRoot));
    const configFile = path.join(fixture.root, ".sennel", "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    fs.writeFileSync(configFile, `${JSON.stringify({ ...config, flow: { specDir: configuredSpecRoot } })}\n`);
    const unrelatedCwd = createTmpDir("flow-query-unrelated-cwd-");
    fixtureRoots.push(unrelatedCwd);

    const result = spawnSync(process.execPath, [CLI, "flow", "query"], {
      cwd: unrelatedCwd,
      env: { ...fixture.env, SENNEL_WORK_ROOT: fixture.root },
      input: JSON.stringify(fixture.request()),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.item.identity.specId, fixture.specId);
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

  it("binds metadata and Activity reads to one persisted generation independently of capture time", async () => {
    const fixture = await contractFixture();
    const before = fixture.snapshot();
    const metadata = queryFixture(fixture, fixture.request());
    const activities = query(fixture.env, fixture.request("activities"));
    const repeated = queryFixture(fixture, fixture.request());
    assert.equal(metadata.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
    assert.equal(activities.snapshot.id, metadata.snapshot.id);
    assert.equal(repeated.snapshot.id, metadata.snapshot.id);
    assert.notEqual(repeated.snapshot.capturedAt, metadata.snapshot.capturedAt);
    assert.equal(metadata.snapshot.confirmationOrder, fixture.flowManager.canonicalState(fixture.specId).confirmationOrder);
    assert.match(metadata.snapshot.catalogHash, /^[a-f0-9]{64}$/);
    assert.match(metadata.snapshot.projectionHash, /^[a-f0-9]{64}$/);
    assert.match(metadata.snapshot.availableFlowVersionsHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it("changes snapshot and rejects a cursor when a stored Version is added", async () => {
    const fixture = await contractFixture();
    const first = query(fixture.env, fixture.request("activities", { page: { limit: 1, after: null } }));
    // Reuse the Versioned record seed: current fresh Flow creation owns Version 1.
    const second = fixture.materializeVersion(2);
    const metadata = queryFixture(fixture, fixture.request());
    assert.deepEqual(metadata.availableFlowVersions, [1, 2]);
    assert.notEqual(metadata.snapshot.id, first.snapshot.id);
    assert.notEqual(metadata.snapshot.availableFlowVersionsHash, first.snapshot.availableFlowVersionsHash);
    const result = runQuery(fixture, fixture.request("activities", { page: { limit: 1, after: first.pageInfo.endCursor } }));
    assert.equal(result.status, 1);
    assertKnownResourceError(JSON.parse(result.stdout), "activities", FLOW_QUERY_ERROR_CODES.SNAPSHOT_CHANGED, "/page/after", { pageLimit: 1 });
    assert.equal(JSON.parse(fs.readFileSync(second.flowStateFile, "utf8")).flowVersion, 2);
  });

  it("rejects a digest-valid revision 2 cursor at the public CLI boundary", async () => {
    const fixture = await contractFixture();
    const payload = { version: 2, schemaRevision: 2, snapshotId: `sha256:${"a".repeat(64)}`,
      specId: fixture.specId, flowVersion: 1, resource: "activities", gte: null, lt: null, order: 1 };
    const after = Buffer.from(Cursor.canonicalJson({ ...payload, digest: Cursor.digest(payload) }), "utf8").toString("base64url");
    const result = runQuery(fixture, fixture.request("activities", { page: { limit: 1, after } }));
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.INVALID_CURSOR, "/page/after", { pageLimit: 1 });
    assert.equal(response.snapshot, null);
  });

  it("preserves the saved ordered tree and maps Task nodes separately from Definition Step IDs", () => {
    const fixture = createFlow({ withTask: true });
    const response = query(fixture.env, fixture.request);
    const saved = fixture.flowManager.canonicalState("001-query");
    const nodes = new Map(response.item.structure.nodes.map((node) => [node.id, node]));
    const visit = (node, parentId = null) => {
      const view = nodes.get(node.id);
      assert.ok(view, node.id);
      assert.equal(view.key, node.key);
      assert.equal(view.kind, node.kind);
      assert.equal(view.status, node.status);
      assert.equal(view.attemptSequence, node.attemptSequence);
      assert.equal(view.parentId, parentId);
      assert.deepEqual(view.childIds, node.steps.map((child) => child.id));
      for (const child of node.steps) visit(child, node.id);
    };
    visit(saved.root);
    assert.equal(response.item.structure.rootNodeId, saved.root.id);
    assert.deepEqual(response.item.structure.stepIds, response.item.structure.nodes.filter((node) => node.kind === "step").map((node) => node.id));
    assert.deepEqual(response.item.relationships.taskNodes, [{ taskId: "T-1", nodeId: "T-1" }]);
    assert.equal(nodes.get("T-1").displayName, "Query fixture task");
    assert.equal(nodes.get("T-1").displayNameSource, "spec-title");
    assert.equal(nodes.get("T-1-impl").definitionStepId, "task-impl");
    assert.equal(nodes.get("T-1").definitionStepId, null);
  });

  async function publishLargeReview(fixture, size, { recommendationSize = 0 } = {}) {
    fixture.flow.activate("spec-review");
    const finding = { kind: "blocking", findingId: "query-byte-bound", title: "Preserve full detail text",
      target: "goal", issue: "A long persisted finding must remain intact.", requiredChange: recommendationSize === 0 ? "Keep the full saved description." : "x".repeat(recommendationSize),
      whyBlocking: "The consumer needs the original observation.", body: "あ".repeat(size) };
    const context = { root: tmp, mainRoot: tmp, executionRoot: tmp, specId: "001-query", phase: "spec",
      flowManager: fixture.flowManager, flowState: fixture.flow.state(), config: {} };
    const command = new RunReviewCommand({ runCommand: (_command, _args, options) => {
      const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
      const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
      const delta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: review.identity.toJSON(),
        baseReviewDigest: review.digest, findings: [finding], operations: [] });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"), `${JSON.stringify(delta.toJSON())}\n`);
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    } });
    const result = await command.execute(context);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    await FLOW_COMMANDS.run.review.post(context, result);
    const reread = makeFlowManager(tmp).readCurrentSpecReview({ specId: "001-query", consumerNodeId: "spec-review" });
    assert.equal(reread.review.toJSON().findings[0].body, finding.body);
    assert.equal(reread.review.toJSON().findings[0].requiredChange, finding.requiredChange);
    return finding;
  }

  it("shrinks byte-bounded pages while preserving complete saved detail text and total count", async () => {
    const fixture = createFlow({ git: true });
    const finding = await publishLargeReview(fixture, 600_000);
    for (let index = 0; index < 95; index += 1) fixture.flowManager.addNote(`${index}:${"x".repeat(4000)}`, { specId: "001-query" });
    const ledger = fixture.flowManager.activityLedger("001-query");
    const descriptor = fixture.flowManager.artifactCatalog("001-query").artifacts.find((entry) => entry.logicalKey === "spec.review");
    const producer = ledger.find((entry) => entry.id === descriptor.activityId);
    const request = activityRequestFrom(fixture, producer, { limit: 100 });
    const pages = [];
    let after = request.page.after;
    do {
      const result = runQuery(fixture, { ...request, page: { limit: 100, after } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(Buffer.byteLength(result.stdout, "utf8") <= queryFixtureLimits().MAX_RESPONSE_BYTES);
      const response = JSON.parse(result.stdout);
      const consumed = new FlowQueryConsumer().consume(response);
      assert.ok(response.items.length > 0);
      assert.deepEqual(consumed.entities, response.entities);
      pages.push(response);
      after = response.pageInfo.endCursor;
    } while (pages.at(-1).pageInfo.hasNext);
    assert.ok(pages.length > 1);
    assert.ok(pages[0].pageInfo.returnedItems < 100);
    const items = pages.flatMap((page) => page.items);
    assert.equal(items.length, ledger.filter((entry) => entry.confirmationOrder >= producer.confirmationOrder).length);
    assert.ok(pages.every((page) => page.pageInfo.totalItems === ledger.length));
    assert.equal(pages.reduce((count, page) => count + page.pageInfo.returnedItems, 0), items.length);
    assert.equal(new Set(items.map((item) => item.activity.id)).size, items.length);
    const detail = pages.flatMap((page) => page.entities.findings).find((entry) => entry.identity.sourceFindingId === finding.findingId);
    assert.equal(detail.description, finding.body);
    assert.ok(pages.every((page) => page.snapshot.id === pages[0].snapshot.id));
  });

  it("rejects an indivisible Activity detail closure over the response byte limit", async () => {
    const fixture = createFlow({ git: true });
    // The worker document stays below its 2 MiB limit. The public finding
    // exposes the saved recommendation in both generic and specific views.
    await publishLargeReview(fixture, 600_000, { recommendationSize: 200_000 });
    const ledger = fixture.flowManager.activityLedger("001-query");
    const descriptor = fixture.flowManager.artifactCatalog("001-query").artifacts.find((entry) => entry.logicalKey === "spec.review");
    const producer = ledger.find((entry) => entry.id === descriptor.activityId);
    const confirmed = ledger.find((entry) => entry.type === "result_confirmed"
      && entry.nodeId === producer.nodeId && entry.attemptId === producer.attemptId
      && entry.sequence === producer.sequence && entry.result?.stepResult !== undefined);
    assert.ok(confirmed, "the real Step result consumes its same-Attempt Review publication");
    const request = activityRequestFrom(fixture, producer);
    let after = request.page.after;
    let response;
    for (let iteration = 0; iteration < ledger.length; iteration += 1) {
      const result = runQuery(fixture, { ...request, page: { limit: 1, after } });
      response = JSON.parse(result.stdout);
      if (response.ok === false) {
        assert.equal(result.status, 1);
        break;
      }
      assert.equal(response.pageInfo.hasNext, true, "the oversized producer must still remain in the page sequence");
      after = response.pageInfo.endCursor;
    }
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.RESPONSE_TOO_LARGE, "/response", { pageLimit: 1 });
  });

  it("paginates by confirmationOrder without gaps or duplicates", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flowManager.addNote("First persisted page observation.", { specId: "001-query" });
    fixture.flowManager.addNote("Second persisted page observation.", { specId: "001-query" });

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
    const expectedOrders = Array.from({ length: fixture.flowManager.canonicalState("001-query").confirmationOrder }, (_, index) => index + 1);
    assert.deepEqual(orders, expectedOrders);
    assert.ok(pages.every((page) => page.snapshot.id === pages[0].snapshot.id));
    assert.ok(pages.every((page) => page.pageInfo.totalItems === expectedOrders.length));
    assert.equal(pages.reduce((count, page) => count + page.pageInfo.returnedItems, 0), expectedOrders.length);
    assert.equal(pages.at(-1).pageInfo.hasNext, false);
  });

  it("refuses a replaced Spec Review generation without substituting the current body", async () => {
    const fixture = createFlow({ git: true });
    await publishLargeReview(fixture, 100);
    const previous = fixture.flowManager.activityLedger("001-query").find((entry) => entry.reviewPublication?.stage === "spec-review");
    fixture.flow.activate("spec-triage", { settlePredecessors: false });
    const source = fixture.flowManager.readCurrentSpecReview({ specId: "001-query", consumerNodeId: "spec-triage" });
    const delta = new SpecReviewDelta({ version: 2, stage: "spec-triage", identity: source.review.identity.toJSON(),
      baseReviewDigest: source.review.digest, findings: [], operations: [] });
    const next = mergeSpecReviewDelta({ review: source.review, delta });
    const commandResult = { result: "Recorded no-op Spec triage generation" };
    attachCanonicalCommandResultArtifact(commandResult, { logicalKey: "spec.triage", payload: delta.toJSON() });
    attachCanonicalCommandResultPublications(commandResult, [new CanonicalCommandResultPublication({
      logicalKey: "spec.review", parameters: { revision: String(source.revision).padStart(3, "0") },
      mediaType: "application/json", payload: next.toJSON(),
    })]);
    fixture.flowManager.updateStepStatus({ stepId: "spec-triage", requestedStatus: "done" }, { specId: "001-query", canonicalCommandResult: commandResult });
    const reread = makeFlowManager(tmp).readCurrentSpecReview({ specId: "001-query", consumerNodeId: "spec-triage" });
    assert.ok(previous.reviewPublication.generation < reread.review.generation);
    assert.deepEqual(reread.review.toJSON(), next.toJSON());
    // New publications retain their Review. Model already-lost history by
    // removing only that optional archive from this test-local canonical input.
    const location = fixture.flow.location();
    const catalog = FlowArtifactCatalog.fromSerialized(JSON.parse(fs.readFileSync(location.catalogFile, "utf8")));
    const archives = catalog.artifacts.filter((entry) => entry.logicalKey === "activity.evidence"
      && entry.activityId === previous.id);
    assert.equal(archives.length, 1);
    const archive = archives[0];
    const document = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence").contentContract
      .parse(fs.readFileSync(location.resolve(archive.relativePath)));
    assert.ok(document instanceof FlowArtifactSpecReviewActivityEvidenceDocument);
    assert.equal(document.review.digest, previous.reviewPublication.reviewDigest);
    fs.unlinkSync(location.resolve(archive.relativePath));
    const unretained = FlowArtifactCatalog.regenerate(catalog.artifacts.filter((entry) => entry !== archive));
    fs.writeFileSync(location.catalogFile, `${JSON.stringify(unretained.toJSON())}\n`);
    unretained.verify(location);
    const protectedFiles = ["flowStateFile", "activitiesFile", "catalogFile"].map((field) => fixture.flow.location()[field]);
    const before = protectedFiles.map((file) => fs.readFileSync(file));
    const result = runQuery(fixture, activityRequestFrom(fixture, previous));
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.DETAIL_UNAVAILABLE, "/canonical", { pageLimit: 1 });
    assert.equal(response.error.reason, "SOURCE_GENERATION_NOT_RETAINED");
    assert.equal(response.error.referenceId, previous.id);
    assert.deepEqual(protectedFiles.map((file) => fs.readFileSync(file)), before);
    const whole = runQuery(fixture, { resource: "activities", condition: { specId: "001-query" }, page: { limit: 100, after: null } });
    assert.equal(whole.status, 1);
    assertKnownResourceError(JSON.parse(whole.stdout), "activities", FLOW_QUERY_ERROR_CODES.DETAIL_UNAVAILABLE, "/canonical", { pageLimit: 100 });
  });

  it("keeps a cursor position stable when the active ledger receives an unconfirmed suffix", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flowManager.addNote("Stable persisted page observation.", { specId: "001-query" });

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
    assert.equal(next.snapshot.id, first.snapshot.id);
  });

  it("rejects a previous cursor after a confirmed active append while preserving stored Activity IDs", () => {
    const fixture = createFlow({ withTask: true });
    const request = {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 100, after: null },
    };
    const before = query(fixture.env, request);
    assert.equal(before.pageInfo.hasNext, false);
    assert.notEqual(before.pageInfo.endCursor, null);

    fixture.flowManager.addNote("A new confirmed administrative observation.", { specId: "001-query" });
    const after = query(fixture.env, request);
    const continuation = JSON.parse(runQuery(fixture, {
      ...request,
      page: { limit: 100, after: before.pageInfo.endCursor },
    }).stdout);

    assert.deepEqual(after.items.slice(0, before.items.length), before.items);
    assert.notEqual(after.snapshot.id, before.snapshot.id);
    assertKnownResourceError(continuation, "activities", FLOW_QUERY_ERROR_CODES.SNAPSHOT_CHANGED, "/page/after", { pageLimit: 100 });
    assert.equal(continuation.snapshot.id, after.snapshot.id);
  });

  it("projects the exact Activity shape and filters by timing.finishedAt", () => {
    const fixture = createFlow();
    const finishedAt = fixture.flowManager.activityLedger("001-query")[0].timing.finishedAt;
    const response = query(fixture.env, {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 100, after: null },
      recordedAt: {
        gte: finishedAt,
        lt: new Date(Date.parse(finishedAt) + 1).toISOString(),
      },
    });
    const item = response.items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      "activity", "artifactIds", "attempt", "blocker", "confirmationOrder", "evaluationIds",
      "failure", "findingIds", "incomplete", "metric", "node", "note", "outcome", "repairIds",
      "sequence", "task", "timing", "transition", "usage", "detailRefs", "referenceBindings", "detailCoverage",
    ].sort());
    assert.deepEqual(item.activity, { id: fixture.flowManager.activityLedger("001-query")[0].id, type: "flow_created" });
    const activity = fixture.flowManager.activityLedger("001-query")[0];
    assert.deepEqual(item.node, { id: activity.nodeId, key: activity.nodeKey });
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
      page: { limit: 100, after: null },
      recordedAt: { gte: new Date(Date.parse(finishedAt) + 1).toISOString() },
    });
    assert.equal(zeroMatch.ok, true);
    assert.deepEqual(zeroMatch.items, []);
    assert.equal(zeroMatch.pageInfo.endCursor, null);
  });

  it("keeps canonical Review stop evidence out of the public Activity failure contract", async () => {
    const fixture = createFlow({ git: true });
    await fixture.flow.activateWithProducers("impl-review");
    fixture.flowManager.failCurrentAttempt({
      specId: "001-query",
      failure: {
        category: "tooling",
        code: "AGENT_TIMEOUT",
        message: "The Review provider stopped after its deadline.",
        retryable: true,
        retryKind: "tooling",
        agentStopEvidence: AgentProcessStopEvidence.confirmed(),
      },
    });
    const savedFailure = fixture.flowManager.activityLedger("001-query").find((entry) => entry.failure?.code === "AGENT_TIMEOUT");
    const response = query(fixture.env, activityRequestFrom(fixture, savedFailure));
    const item = response.items.find((entry) => entry.failure?.code === "AGENT_TIMEOUT");

    assert.ok(item, JSON.stringify(response));
    assert.deepEqual(item.failure, {
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "The Review provider stopped after its deadline.",
      retryable: true,
      retryKind: "tooling",
    });
    assert.equal(Object.hasOwn(item.failure, "agentStopEvidence"), false);
    assertNoInternalFields(response);
  });

  it("preserves a confirmed no-change Task outcome across metadata and its supported Activity", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");

    const savedActivity = fixture.flowManager.activityLedger("001-query").findLast((entry) => entry.type === "result_confirmed" && entry.nodeId === "T-1-impl");
    const metadata = query(fixture.env, fixture.request);
    const node = metadata.item.structure.nodes.find((entry) => entry.id === "T-1-impl");
    assert.equal(node.taskId, "T-1");
    assert.equal(node.result.outcome, "passed");
    assert.equal(node.result.summary, savedActivity.result.summary);
    assert.equal(node.result.summary, "Worker handoff confirmed for task-impl; no source change: The fixture Task requires no source mutation..");
    assert.equal(node.result.confirmedAt, savedActivity.result.confirmedAt);
    assert.deepEqual(node.result.artifactRefs, []);
    const result = runQuery(fixture, activityRequestFrom(fixture, savedActivity));
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    new FlowQueryConsumer().consume(response);
    const item = response.items[0];
    assert.equal(item.activity.id, savedActivity.id);
    assert.deepEqual(item.task, { id: "T-1", key: "T-1" });
    assert.deepEqual(item.outcome, node.result);
    assert.equal(item.failure, null);
    assert.equal(item.blocker, null);
    assert.equal(item.incomplete, null);
    assert.deepEqual(item.detailCoverage.findings, { availability: "available", reason: null, count: 0 });
  });

  it("omits an unresolved opaque result receipt without exposing its stored ID", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");
    rewriteTaskResultReferenceKind(fixture, "unknown-result-artifact");
    const metadata = query(fixture.env, fixture.request);
    const node = metadata.item.structure.nodes.find((entry) => entry.id === "T-1-impl");
    assert.deepEqual(node.result.artifactRefs, []);
    assert.doesNotMatch(JSON.stringify(metadata), /unknown-result-artifact/);
    const saved = fixture.flowManager.activityLedger("001-query").findLast((entry) => entry.type === "result_confirmed" && entry.nodeId === "T-1-impl");
    const result = runQuery(fixture, activityRequestFrom(fixture, saved));
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    new FlowQueryConsumer().consume(response);
    assert.equal(response.items[0].activity.id, saved.id);
    assert.deepEqual(response.items[0].outcome.artifactRefs, []);
    assert.doesNotMatch(JSON.stringify(response), /unknown-result-artifact/);
  });

  it("refuses a real Task source quality observation without pretending that findings are absent", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    completeCanonicalSourceHandoff({ root: tmp, manager: fixture.flowManager, specId: "001-query", stepId: "task-impl", taskId: "T-1",
      effect: { version: 1, stepId: "task-impl", completionStatus: "done",
        issues: [{ classification: "quality", reason: "The existing source has a retained quality observation.",
          remainingRisk: "The quality observation requires a supported public detail mapping." }],
        overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
        noChangeReason: "The existing source needs no mutation for this requested behavior." },
    });
    const reloaded = makeFlowManager(tmp);
    const saved = reloaded.activityLedger("001-query").findLast((entry) => entry.type === "result_confirmed" && entry.nodeId === "T-1-impl");
    assert.equal(saved.result.stepResult.evidence.qualityIssueCount, 1);
    assert.equal(reloaded.canonicalState("001-query").findNode("T-1-impl").result.toJSON().stepResult.evidence.qualityIssueCount, 1);
    const result = runQuery(fixture, activityRequestFrom(fixture, saved));
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.DETAIL_UNAVAILABLE, "/canonical", { pageLimit: 1 });
    assert.equal(response.error.reason, "PRODUCER_NOT_SUPPORTED");
    assert.equal(response.error.referenceId, saved.id);
  });

  it("rejects an unresolved result reference that claims a catalog relation", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flow.settleBefore("T-1-impl");
    fixture.flow.activateTask("T-1", { settlePredecessors: false });
    fixture.flow.settle("T-1-impl");
    rewriteTaskResultReferenceKind(fixture, "path");

    const result = spawnSync("node", [CLI, "flow", "query"], {
      env: fixture.env,
      input: JSON.stringify({ resource: "activities", condition: { specId: "001-query" }, page: { limit: 100, after: null } }),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assertKnownResourceError(
      JSON.parse(result.stdout),
      "activities",
      FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT,
      "/canonical",
      { pageLimit: 100 },
    );
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

    const oversizedField = spawnSync("node", [CLI, "flow", "query"], {
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      input: JSON.stringify({
        resource: "metadata",
        condition: { specId: "001-query" },
        ["x".repeat(5_000)]: true,
      }),
      encoding: "utf8",
    });
    assert.equal(oversizedField.status, 1);
    const oversizedFieldResponse = JSON.parse(oversizedField.stdout);
    assert.equal(oversizedFieldResponse.error.code, FLOW_QUERY_ERROR_CODES.INVALID_REQUEST);
    assert.equal(oversizedFieldResponse.error.path, "/request");
  });

  it("keeps QueryRequest as the typed input boundary", () => {
    assert.equal(new QueryRequest({ resource: "metadata", condition: { specId: "001-query" } }).resource, "metadata");
    assert.throws(
      () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" } }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page",
    );
    assert.throws(
      () => new QueryRequest({ resource: "metadata", condition: { specId: "001-query" }, page: {} }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page",
    );
    assert.throws(
      () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit: 1 } }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page/after",
    );
    for (const limit of [0, 101, 1.5]) {
      assert.throws(
        () => new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit, after: null } }),
        (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page/limit",
      );
    }
  });

  it("requires an exact Activity page and a non-empty timezone-bearing recordedAt range", () => {
    const request = (overrides = {}) => new QueryRequest({
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 1, after: null },
      ...overrides,
    });

    const lowerBound = request({ recordedAt: { gte: "2026-01-02T00:00:00Z" } }).recordedAt;
    assert.equal(lowerBound.gte, "2026-01-02T00:00:00Z");
    assert.equal(lowerBound.lt, null);
    const upperBound = request({ recordedAt: { lt: "2026-01-03T00:00:00+09:00" } }).recordedAt;
    assert.equal(upperBound.gte, null);
    assert.equal(upperBound.lt, "2026-01-03T00:00:00+09:00");
    assert.equal(request({ recordedAt: { gte: "2026-01-02T00:00:00+14:00" } }).recordedAt.gte, "2026-01-02T00:00:00+14:00");
    const boundedRange = request({ recordedAt: { gte: "2026-01-02T00:00:00Z", lt: "2026-01-03T00:00:00Z" } }).recordedAt;
    assert.equal(boundedRange.gte, "2026-01-02T00:00:00Z");
    assert.equal(boundedRange.lt, "2026-01-03T00:00:00Z");

    for (const recordedAt of [
      {},
      { gte: "2026-01-02T00:00:00Z", unexpected: true },
      { gte: null },
      { gte: "2026-01-02T00:00:00" },
      { gte: "2026-02-30T00:00:00Z" },
      { gte: "2026-01-02T00:00:00+24:00" },
      { gte: "2026-01-02T00:00:00+14:01" },
      { gte: "2026-01-02T00:00:00+00:60" },
      { gte: "2026-01-03T00:00:00Z", lt: "2026-01-02T00:00:00Z" },
    ]) {
      assert.throws(
        () => request({ recordedAt }),
        (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST,
      );
    }
    assert.throws(
      () => request({ page: { limit: 1, after: null, unexpected: true } }),
      (error) => error.code === FLOW_QUERY_ERROR_CODES.INVALID_REQUEST && error.jsonPath === "/page/unexpected",
    );
  });

  it("preserves the decoding cause when rejecting a malformed cursor", () => {
    const request = new QueryRequest({ resource: "activities", condition: { specId: "001-query" }, page: { limit: 1, after: null } });
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
    const malformed = JSON.parse(runQuery(fixture, { ...request, page: { limit: 1, after: tampered } }).stdout);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, FLOW_QUERY_ERROR_CODES.INVALID_CURSOR);
    assert.equal(malformed.error.path, "/page/after");

    const mismatch = JSON.parse(runQuery(fixture, {
      ...request,
      recordedAt: { gte: "2000-01-01T00:00:00Z" },
      page: { limit: 1, after: first.pageInfo.endCursor },
    }).stdout);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, FLOW_QUERY_ERROR_CODES.CURSOR_QUERY_MISMATCH);
    assert.equal(mismatch.error.path, "/page/after");
  });

  it("covers fresh lifecycle variants and preserves the canonical Git snapshot", async () => {
    const cases = [
      { lifecycle: "active", git: false, expectedLifecycle: "active", blocked: false },
      { lifecycle: "parked", git: false, expectedLifecycle: "parked", blocked: false },
      { lifecycle: "blocked", git: true, expectedLifecycle: "active", blocked: true },
      { lifecycle: "finalized", git: true, expectedLifecycle: "finalized", blocked: false },
    ];
    for (const testCase of cases) {
      const fixture = await contractFixture(testCase);
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
        const repeated = queryFixture(fixture, fixture.request());
        assert.deepEqual({ ...repeated, snapshot: { ...repeated.snapshot, capturedAt: response.snapshot.capturedAt } }, response);
      }
    }
  });

  it("uses the same reader for migrated direct records and Version 2 envelopes", async () => {
    const fixture = await contractFixture({ storage: "migrated", selectedVersion: 2 });
    const before = fixture.snapshot();
    const stateEnvelope = JSON.parse(fs.readFileSync(fixture.locations[2].flowStateFile, "utf8"));
    const specEnvelope = JSON.parse(fs.readFileSync(fixture.locations[2].specFile, "utf8"));
    assert.deepEqual(Object.keys(stateEnvelope).sort(), ["flowVersion", "recordRevision", "specId", "state"].sort());
    assert.deepEqual(Object.keys(specEnvelope).sort(), ["content", "recordRevision", "specId"].sort());
    assert.equal(stateEnvelope.recordRevision, 1);
    assert.equal(stateEnvelope.flowVersion, 2);
    assert.equal(stateEnvelope.state.flowVersion, 2);
    assert.equal(stateEnvelope.state.schemaRevision, CURRENT_FLOW_SCHEMA_REVISION);
    assert.equal(stateEnvelope.state.version, 1);
    assert.equal(specEnvelope.recordRevision, 1);
    assert.equal(fs.readFileSync(fixture.locations[2].activitiesFile, "utf8"), "");
    assert.equal(stateEnvelope.state.confirmationOrder, 0);
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

  it("lets a Workspace/Connector consumer round-trip every public success fixture", async () => {
    const consumer = new FlowQueryConsumer();
    const cases = [
      { options: { lifecycle: "active" }, resource: "metadata" },
      { options: { lifecycle: "parked" }, resource: "metadata" },
      { options: { lifecycle: "blocked" }, resource: "metadata" },
      { options: { lifecycle: "finalized" }, resource: "metadata" },
      { options: { storage: "migrated", selectedVersion: 2 }, resource: "metadata" },
      { options: { lifecycle: "active" }, resource: "activities" },
      { options: { storage: "migrated", selectedVersion: 2 }, resource: "activities" },
    ];

    for (const testCase of cases) {
      const fixture = await contractFixture(testCase.options);
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

  it("lets a consumer reject finalized history whose old detail source was not retained", async () => {
    const fixture = await contractFixture({ lifecycle: "finalized" });
    const metadata = queryFixture(fixture, fixture.request());
    assert.equal(metadata.item.lifecycle.lifecycle, "finalized");
    const before = fixture.snapshot();
    const result = runQuery(fixture, fixture.request("activities"));
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assertKnownResourceError(response, "activities", FLOW_QUERY_ERROR_CODES.DETAIL_UNAVAILABLE, "/canonical", { pageLimit: 100 });
    const consumed = new FlowQueryConsumer().consumeSerialized(result.stdout);
    assert.deepEqual(consumed.items, []);
    assert.deepEqual(consumed.entities, { evaluations: [], findings: [], repairs: [] });
    assert.equal(consumed.completeness, null);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it("lets a Workspace/Connector consumer round-trip bounded Activity pages and filters", () => {
    const fixture = createFlow({ withTask: true });
    fixture.flowManager.addNote("A retained administrative observation.", { specId: "001-query" });

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
      page: { limit: 100, after: null },
      recordedAt: { gte: firstFinishedAt },
    });
    assert.equal(inclusiveResult.status, 0, inclusiveResult.stderr);
    const inclusiveConsumed = consumer.consumeSerialized(inclusiveResult.stdout);
    assert.equal(inclusiveConsumed.items[0].confirmationOrder, 1);
    assert.equal(inclusiveConsumed.pageInfo.totalItems, fullResponse.items.filter((item) => item.timing?.finishedAt !== null
      && item.timing?.finishedAt !== undefined && Date.parse(item.timing.finishedAt) >= Date.parse(firstFinishedAt)).length);

    const exclusiveResult = runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 100, after: null },
      recordedAt: { lt: firstFinishedAt },
    });
    assert.equal(exclusiveResult.status, 0, exclusiveResult.stderr);
    const exclusiveConsumed = consumer.consumeSerialized(exclusiveResult.stdout);
    assert.equal(exclusiveConsumed.items.some((item) => item.confirmationOrder === 1), false);

    const zeroMatchResult = runQuery(fixture, {
      resource: "activities",
      condition: { specId: "001-query" },
      page: { limit: 100, after: null },
      recordedAt: { gte: new Date(Math.max(...fullResponse.items.filter((item) => item.timing?.finishedAt)
        .map((item) => Date.parse(item.timing.finishedAt))) + 1).toISOString() },
    });
    assert.equal(zeroMatchResult.status, 0, zeroMatchResult.stderr);
    const zeroMatchConsumed = consumer.consumeSerialized(zeroMatchResult.stdout);
    assert.deepEqual(zeroMatchConsumed.items, []);
    assert.equal(zeroMatchConsumed.pageInfo.totalItems, 0);
    assert.equal(zeroMatchConsumed.pageInfo.returnedItems, 0);
    assert.deepEqual(zeroMatchConsumed.pageInfo, JSON.parse(zeroMatchResult.stdout).pageInfo);
  });

  it("rejects a response revision the consumer does not support", async () => {
    const fixture = await contractFixture();
    const response = JSON.parse(runQuery(fixture, fixture.request()).stdout);
    const consumer = new FlowQueryConsumer();
    assert.doesNotThrow(() => consumer.consume(response));
    assert.throws(() => new FlowQueryConsumer({ supportedSchemaRevision: 1 }).consume(response), /unsupported query schema revision: 3/);
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
      /query response does not match the query contract/,
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
      /query response does not match the query contract/,
    );
    assert.throws(
      () => consumer.consume({
        ...response,
        item: {
          ...response.item,
          identity: { ...response.item.identity, unexpected: true },
        },
      }),
      /query response does not match the query contract/,
    );
  });

  it("round-trips every known-resource error through the shared error enum", async () => {
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
        jsonPath: "/page/limit",
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
        request: (fixture) => ({ resource: "activities", condition: { specId: "002-query-fixture-missing" }, page: { limit: 100, after: null } }),
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
        request: (fixture) => ({ resource: "activities", condition: { specId: fixture.specId, flowVersion: 2 }, page: { limit: 100, after: null } }),
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
      const fixture = await contractFixture();
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

    const invalidJson = await contractFixture();
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
      /query response does not match the query contract/,
    );
  });

  it("round-trips cursor errors without exposing cursor internals", async () => {
    const consumer = new FlowQueryConsumer();
    const fixture = await contractFixture({ lifecycle: "active" });
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
    assertKnownResourceError(invalidResponse, "activities", FLOW_QUERY_ERROR_CODES.INVALID_CURSOR, "/page/after", { pageLimit: 1 });
    assert.equal(consumer.consumeSerialized(invalid.stdout).error.code, FLOW_QUERY_ERROR_CODES.INVALID_CURSOR);
    assert.equal(invalidResponse.selectedFlowVersion, null);
    assert.deepEqual(invalidResponse.availableFlowVersions, []);

    const mismatch = runQuery(fixture, {
      ...request,
      recordedAt: { gte: "2000-01-01T00:00:00Z" },
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
    assert.deepEqual(Object.keys(projected).sort(), ["activityIds", "artifactId", "metadata", "nodeIds", "taskIds", "artifactKey", "kind", "relativePath", "hash", "algorithm", "hashScope", "size", "authority", "cardinality", "memberId", "publicationStep", "retention", "producerActivityId", "referencingActivityIds"].sort());
    assert.deepEqual(Object.keys(projected.metadata).sort(), ["logicalKey", "mediaType", "schemaRevision"].sort());
    assert.equal(projected.metadata.logicalKey, associated.logicalKey);
    assert.equal(projected.metadata.mediaType, associated.mediaType);
    assert.equal(projected.metadata.schemaRevision, null);
    assert.deepEqual(projected.activityIds, [associated.activityId]);
    assert.deepEqual(projected.nodeIds, [activity.nodeId]);
    assert.deepEqual(projected.taskIds, ["T-1"]);
    assert.equal(projected.relativePath, associated.relativePath);
    assert.equal(projected.kind, associated.kind);
    assert.equal(projected.authority, associated.authority);
    assert.equal(projected.cardinality, associated.cardinality);
    assert.equal(projected.memberId, associated.memberId);
    assert.equal(projected.retention, associated.retention);
    assert.equal(projected.publicationStep, associated.publicationStep);
    assert.equal(projected.producerActivityId, associated.activityId);
    assert.equal(projected.algorithm, "sha256");
    assert.equal(projected.hashScope, "file-bytes");
    const bytes = fs.readFileSync(fixture.flow.location().resolve(associated.relativePath));
    assert.equal(projected.size, bytes.length);
    assert.equal(projected.hash, crypto.createHash("sha256").update(bytes).digest("hex"));
    const keyIdentity = { flowVersionId: response.item.identity.flowVersionId,
      relativePath: associated.relativePath, kind: associated.kind, authority: associated.authority,
      cardinality: associated.cardinality, memberId: associated.memberId };
    assert.equal(projected.artifactKey, `artifact:${crypto.createHash("sha256").update(JSON.stringify(canonicalArtifactIdentity(keyIdentity)), "utf8").digest("hex")}`);
    assert.equal(new Set(projected.activityIds).size, projected.activityIds.length);
    assert.equal(new Set(projected.nodeIds).size, projected.nodeIds.length);
    assert.equal(new Set(projected.taskIds).size, projected.taskIds.length);
  });

  it("rejects every unsupported canonical authority revision", async () => {
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
        fixture: () => contractFixture({ selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].flowStateFile;
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          state.recordRevision = 2;
          fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
        },
      },
      {
        name: "Versioned Spec record envelope",
        fixture: () => contractFixture({ selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].specFile;
          const spec = JSON.parse(fs.readFileSync(file, "utf8"));
          spec.recordRevision = 2;
          fs.writeFileSync(file, `${JSON.stringify(spec)}\n`);
        },
      },
      {
        name: "FlowActivity ledger format",
        fixture: () => contractFixture({ selectedVersion: 2 }),
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
        fixture: () => contractFixture({ selectedVersion: 2 }),
        mutate: (fixture) => {
          const file = fixture.locations[2].catalogFile;
          const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
          catalog.schemaRevision = 3;
          fs.writeFileSync(file, `${JSON.stringify(catalog)}\n`);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await testCase.fixture();
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

  it("classifies missing records, identity mismatch, and catalog revision errors as canonical errors", async () => {
    const missing = await contractFixture();
    fs.unlinkSync(missing.locations[1].specFile);
    const missingBefore = missing.snapshot();
    const missingResult = runQuery(missing, missing.request());
    assert.equal(missingResult.status, 1);
    assertKnownResourceError(JSON.parse(missingResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical");
    assert.deepEqual(missing.snapshot(), missingBefore);

    const missingArtifact = await contractFixture();
    const artifactCatalog = JSON.parse(fs.readFileSync(missingArtifact.locations[1].catalogFile, "utf8"));
    const catalogedArtifact = artifactCatalog.artifacts.find((artifact) => artifact.relativePath === "revisions/001/spec.json");
    assert.ok(catalogedArtifact);
    fs.unlinkSync(missingArtifact.locations[1].resolve(catalogedArtifact.relativePath));
    const missingArtifactBefore = missingArtifact.snapshot();
    const missingArtifactResult = runQuery(missingArtifact, missingArtifact.request());
    assert.equal(missingArtifactResult.status, 1);
    assertKnownResourceError(JSON.parse(missingArtifactResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_UNREADABLE, "/canonical");
    assert.deepEqual(missingArtifact.snapshot(), missingArtifactBefore);

    const catalog = await contractFixture();
    const catalogValue = JSON.parse(fs.readFileSync(catalog.locations[1].catalogFile, "utf8"));
    catalogValue.schemaRevision = 1;
    fs.writeFileSync(catalog.locations[1].catalogFile, `${JSON.stringify(catalogValue)}\n`);
    const catalogBefore = catalog.snapshot();
    const catalogResult = runQuery(catalog, catalog.request());
    assert.equal(catalogResult.status, 1);
    assertKnownResourceError(JSON.parse(catalogResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(catalog.snapshot(), catalogBefore);

    const identity = await contractFixture({ storage: "fresh", selectedVersion: 2 });
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

    const oversized = await contractFixture();
    fs.writeFileSync(oversized.locations[1].flowStateFile, Buffer.alloc(queryFixtureLimits().MAX_STATE_RECORD_BYTES + 1, 0x20));
    const oversizedBefore = oversized.snapshot();
    const oversizedResult = runQuery(oversized, oversized.request());
    assert.equal(oversizedResult.status, 1);
    assertKnownResourceError(JSON.parse(oversizedResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(oversized.snapshot(), oversizedBefore);
  });

  it("classifies a discontinuous confirmed ledger with the activities error envelope", async () => {
    const fixture = await contractFixture();
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

  it("rejects bounded canonical inputs without truncating the available Version set or ledger", async () => {
    const versions = await contractFixture();
    const versionRoot = path.dirname(versions.locations[1].directory);
    for (let version = 2; version <= queryFixtureLimits().MAX_AVAILABLE_FLOW_VERSIONS + 1; version += 1) {
      fs.mkdirSync(path.join(versionRoot, String(version)));
    }
    const versionsBefore = versions.snapshot();
    const versionsResult = runQuery(versions, versions.request());
    assert.equal(versionsResult.status, 1);
    assertKnownResourceError(JSON.parse(versionsResult.stdout), "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.deepEqual(versions.snapshot(), versionsBefore);

    const symlinkVersion = await contractFixture();
    const symlinkVersionRoot = path.dirname(symlinkVersion.locations[1].directory);
    fs.symlinkSync(symlinkVersion.locations[1].directory, path.join(symlinkVersionRoot, "2"), "dir");
    const symlinkResult = runQuery(symlinkVersion, symlinkVersion.request());
    assert.equal(symlinkResult.status, 1);
    const symlinkResponse = JSON.parse(symlinkResult.stdout);
    assertKnownResourceError(symlinkResponse, "metadata", FLOW_QUERY_ERROR_CODES.CANONICAL_RECORD_INCONSISTENT, "/canonical");
    assert.equal(symlinkResponse.selectedFlowVersion, null);
    assert.deepEqual(symlinkResponse.availableFlowVersions, []);

    const ledger = await contractFixture();
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

  it("keeps request-file, boundary, resource-shape, and bounded-input fixtures explicit", async () => {
    const fixture = await contractFixture();
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
        input: JSON.stringify({ resource: "activities", condition: { specId: fixture.specId }, page: { limit: 1, after: null }, recordedAt: {} }),
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
        assert.deepEqual(Object.keys(response).sort(), ["error", "guidance", "ok", "schemaRevision", "snapshot", "completeness"].sort());
        assert.equal(response.schemaRevision, FLOW_QUERY_SCHEMA_REVISION);
        assert.equal(response.ok, false);
        assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "path", "reason", "referenceId"]);
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
