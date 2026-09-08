import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../support/builders/tmp-dir.js";
import { buildCurrentFlowDefinition } from "../../src/flow/definition.js";
import { FlowArtifactCatalog, FlowVersionAuthorityScope, FlowVersionLocation } from "../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import { CurrentFlowVersionStore, CurrentFlowState, FlowActivity } from "../../src/flow/lib/current-flow-state.js";
import { initialCanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import {
  canonicalVersionDirectories,
  LegacyFlowSource,
  LegacyRuntimeResidueClassifier,
  SpecsMigrationCandidate,
  SpecsMigrationTransaction,
  CanonicalRevisionRootTransaction,
} from "../../src/lib/specs-migration.js";
import { resolveMigrationSpecRoot } from "../../src/lib/migration-spec-root.js";

const CLI = path.resolve("src/sennel.js");
const roots = [];

function project() {
  const root = createTmpDir("sennel-specs-migration-");
  roots.push(root);
  writeJson(root, ".sennel/config.json", { flow: { specDir: "specs" } });
  return root;
}

function run(root, args = []) {
  return runTo(root, 2, args);
}

function runTo(root, target, args = []) {
  return spawnSync(process.execPath, [CLI, "migrate", "specs", "--to", String(target), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
}

function runLayout(root, args = []) {
  return spawnSync(process.execPath, [CLI, "migrate", "layout", "--to", "1", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
}

function seedLegacy(root, id = "515-specs-migration") {
  const base = `specs/${id}`;
  writeJson(root, `${base}/flow.json`, {
    spec: `${base}/spec.md`,
    request: "Preserve legacy Flow history.",
    baseBranch: "main",
    featureBranch: `feature/${id}`,
    autoApprove: true,
    steps: [
      { id: "draft", status: "done" },
      { id: "implement", status: "pending" },
    ],
    tasks: [{
      id: "T-1",
      title: "Migrate the Flow",
      status: "in_progress",
      steps: [
        { id: "write-tests", status: "done" },
        { id: "implement", status: "in_progress" },
      ],
    }],
    currentTaskId: "T-1",
    state: {},
  });
  writeJson(root, `${base}/spec.json`, {
    title: "Migration fixture",
    tasks: [{ id: "T-1", title: "Migrate the Flow" }],
  });
  writeFile(root, `${base}/spec.md`, "# Migration fixture\n");
  writeFile(root, `${base}/issue.md`, "# Legacy issue snapshot\n");
  writeFile(root, `${base}/tests/sample.test.js`, "export default true;\n");
  writeFile(root, `${base}/tests/.raw/test-execution.log`, "legacy test output\n");
  writeFile(root, `${base}/review.md`, "# Legacy review\n");
  return id;
}

function legacyDefinitionSteps({ current = "branch" } = {}) {
  const root = buildCurrentFlowDefinition().materializeRoot().toJSON();
  const convert = (node) => ({
    id: node.id,
    status: node.id === current || node.id === "plan" ? "in_progress" : "pending",
    steps: node.steps.map(convert),
  });
  return root.steps.map(convert);
}

function legacyStepLocation(nodes, id, pointer = "/steps") {
  for (const [index, node] of nodes.entries()) {
    const nodePointer = `${pointer}/${index}`;
    if (node.id === id) return { node, pointer: nodePointer };
    const childField = Array.isArray(node.children) ? "children" : Array.isArray(node.steps) ? "steps" : null;
    if (childField === null) continue;
    const nested = legacyStepLocation(node[childField], id, `${nodePointer}/${childField}`);
    if (nested !== null) return nested;
  }
  return null;
}

function seedContinuableLegacy(root, id = "515-continuable-history") {
  const base = `specs/${id}`;
  writeJson(root, `${base}/flow.json`, {
    spec: `${base}/spec.json`,
    request: "Continue from a directly saved historical cursor.",
    steps: legacyDefinitionSteps(),
    tasks: [],
    currentTaskId: "branch",
  });
  writeJson(root, `${base}/spec.json`, { title: "Continuable legacy fixture", tasks: [] });
  return id;
}

function startActivity(state, {
  id = "migration-next-valid-mutation",
  nodeId = "branch",
  sequence = 1,
} = {}) {
  const node = state.findNode(nodeId);
  const attemptId = `migration-attempt-${sequence}`;
  return new FlowActivity({
    id,
    nodeId: node.id,
    nodeKey: node.key,
    attemptId,
    sequence,
    confirmationOrder: state.confirmationOrder + 1,
    type: "attempt_started",
    transition: {
      operation: "start_attempt",
      nodeId: node.id,
      task: null,
      attempt: {
        id: attemptId,
        nodeId: node.id,
        sequence,
        startedAt: "2026-01-01T00:00:00.000Z",
        consumption: { semantic: 0, tooling: 0 },
        failure: null,
        blocker: null,
        incomplete: [],
        operationClaims: [],
      },
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      finalizeSteps: null,
    },
    result: null,
    timing: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", durationMs: 0 },
    failure: null,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function plannedCandidate(root, id) {
  const specRoot = resolveMigrationSpecRoot(root).root;
  const source = LegacyFlowSource.inspect(path.join(root, "specs", id), id);
  return {
    specRoot,
    candidate: SpecsMigrationCandidate.plan(source, buildCurrentFlowDefinition()),
  };
}

function createExistingVersion(root, id, { flowId, flowVersionId, runId }) {
  const store = versionStore(root, id);
  store.createFresh({
    flowId,
    flowVersionId,
    runId,
    request: "Existing canonical identity.",
    specRecord: { id, title: "Existing", tasks: [] },
  });
}

function versionStore(root, id, version = 1) {
  return new CurrentFlowVersionStore({
    location: new FlowVersionLocation({
      repositoryRoot: root,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: "specs",
      specId: id,
      version,
    }),
    definition: buildCurrentFlowDefinition(),
  });
}

function assertDormantHistoricalContinuationRefused(store, state, activity) {
  const before = JSON.stringify(store.load().toJSON());
  const activityCount = store.activities().length;
  assert.equal(state.history.execution, "dormant");
  assert.equal(state.nextAction(), null);
  assert.throws(
    () => store.apply({ activity }),
    /state (node|children) do(?:es)? not match definition|historical continuation/,
  );
  assert.equal(JSON.stringify(store.load().toJSON()), before);
  assert.equal(store.activities().length, activityCount);
}

function legacyFlow(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, "specs", id, "flow.json"), "utf8"));
}

function writeLegacyFlow(root, id, flow) {
  writeJson(root, `specs/${id}/flow.json`, flow);
}

function rewriteCatalogFile(version, rewriteArtifacts) {
  const catalogPath = path.join(version, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const artifacts = rewriteArtifacts(catalog.artifacts);
  const refreshed = new FlowArtifactCatalog({ artifacts });
  fs.writeFileSync(catalogPath, `${JSON.stringify(refreshed.toJSON(), null, 2)}\n`);
}

function refreshCatalogDescriptorForBytes(version, relativePath) {
  rewriteCatalogFile(version, (artifacts) => artifacts.map((entry) => {
    if (entry.relativePath !== relativePath) return entry;
    const bytes = fs.readFileSync(path.join(version, relativePath));
    return {
      ...entry,
      hash: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }));
}

function refreshCatalogFile(root, id, relativePath) {
  const version = path.join(root, "specs", id, "001");
  refreshCatalogDescriptorForBytes(version, relativePath);
}

function appendLegacyReviewDescriptor(versionDirectory, relativePath, bytes, { activityId = null, migrationMaterialization = true, publicationStep = "system" } = {}) {
  const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  catalog.artifacts.push({
    logicalKey: null,
    kind: "migration-materialization",
    relativePath,
    hash: digest,
    size: bytes.length,
    mediaType: "application/json",
    authority: "canonical-flow-artifacts",
    cardinality: "collection",
    memberId: `legacy-review-${digest}`,
    publicationStep,
    retention: "permanent",
    activityId,
    migrationMaterialization,
  });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

function writeLegacyReviewDocument(versionDirectory, relativePath, document, options = {}) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(path.join(versionDirectory, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(versionDirectory, relativePath), bytes);
  appendLegacyReviewDescriptor(versionDirectory, relativePath, bytes, options);
}

function refreshRawLegacyDescriptor(versionDirectory, relativePath) {
  const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const bytes = fs.readFileSync(path.join(versionDirectory, relativePath));
  const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
  assert.ok(descriptor, `missing legacy descriptor: ${relativePath}`);
  descriptor.hash = crypto.createHash("sha256").update(bytes).digest("hex");
  descriptor.size = bytes.length;
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

function seedLegacySpecReviewChain(root, id, { malformed = false, acceptedRepair = false } = {}) {
  const first = runTo(root, 1);
  assert.equal(first.status, 0, first.stderr);
  const versionDirectory = path.join(root, "specs", id, "001");
  const preChangeSpecBytes = fs.readFileSync(path.join(versionDirectory, "spec.json"));
  if (acceptedRepair) {
    const current = JSON.parse(fs.readFileSync(path.join(versionDirectory, "spec.json"), "utf8"));
    current.goal = "The repaired legacy Spec is the current immutable authority.";
    fs.writeFileSync(path.join(versionDirectory, "spec.json"), `${JSON.stringify(current, null, 2)}\n`);
    refreshCatalogDescriptorForBytes(versionDirectory, "spec.json");
  }
  const specBytes = fs.readFileSync(path.join(versionDirectory, "spec.json"));
  const compactSpecBytes = Buffer.from(JSON.stringify(JSON.parse(specBytes.toString("utf8"))), "utf8");
  const review = {
    version: 1,
    phase: "spec",
    generatedAt: "2026-08-29T00:00:00.000Z",
    verdict: "REJECTED",
    counts: { blocking: 1, nonBlocking: 0, total: 1 },
    blockingFindings: [{
      findingId: "legacy-review-finding",
      kind: "blocking",
      title: "Legacy finding",
      body: "The legacy review supplies a complete blocking finding.",
      issue: "The immutable input needs a review conversion proof.",
      target: "/goal",
      requiredChange: "Preserve the review finding in canonical form.",
      whyBlocking: "The migration must not lose established blocking evidence.",
    }],
    nonBlockingImprovements: [],
  };
  if (malformed) {
    review.blockingFindings[0].body = "";
  }
  writeLegacyReviewDocument(versionDirectory, "steps/spec-review/result.json", review);
  if (malformed) {
    return versionDirectory;
  }
  const triage = {
    version: 1,
    phase: "spec-triage",
    sourceReview: "spec-review.json",
    summary: "Classify the proven legacy finding.",
    items: [{
      findingId: "legacy-review-finding",
      title: "Legacy finding",
      target: "/goal",
      decision: acceptedRepair ? "apply" : "invalid",
      rationale: "The historical review records this resolved decision.",
      evidence: "The immutable source proves this finding is not applicable.",
      ...(acceptedRepair ? {
        allowedTargets: [{ target: { entity: "spec", field: "goal" }, operationKinds: ["replace-field"] }],
        requiredTargets: [{ entity: "spec", field: "goal" }],
      } : {}),
    }],
  };
  writeLegacyReviewDocument(versionDirectory, "steps/spec-triage/result.json", triage);
  const acceptedOperations = acceptedRepair ? [{
    operation: {
      findingId: "legacy-review-finding",
      kind: "replace-field",
      target: { entity: "spec", field: "goal" },
      expectedDigest: "a".repeat(64),
      replacement: "The repaired legacy Spec is the current immutable authority.",
      reason: "The durable V1 audit records the accepted repair.",
    },
    attempt: 1,
  }] : [];
  for (const entry of acceptedOperations) {
    entry.operationDigest = crypto.createHash("sha256").update(JSON.stringify(entry.operation)).digest("hex");
  }
  const discardedOperations = [];
  const repair = {
    version: 2,
    phase: "spec-repair",
    baseRevision: `sha256:${malformed ? "f".repeat(64) : crypto.createHash("sha256").update(acceptedRepair ? preChangeSpecBytes : specBytes).digest("hex")}`,
    attempts: [],
    acceptedOperations,
    discardedOperations,
    scopeExpansions: [],
    appliedFindings: acceptedRepair ? ["legacy-review-finding"] : [],
    operationDigest: crypto.createHash("sha256").update(JSON.stringify({ acceptedOperations, discardedOperations })).digest("hex"),
    resultRevision: {
      digest: crypto.createHash("sha256").update(compactSpecBytes).digest("hex"),
      byteLength: compactSpecBytes.length,
    },
    audit: { missingRequiredTargets: [] },
  };
  writeLegacyReviewDocument(versionDirectory, "steps/spec-repair/result.json", repair);
  return versionDirectory;
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("specs migration root authority", () => {
  it("separates configuration authority from retired managed-directory presence", () => {
    const table = [
      {
        name: "canonical config survives multiple retired directories without configs",
        canonical: "specs/canonical",
        legacy: [null, null],
        expected: { authority: "canonical", relativePath: "specs/canonical" },
      },
      {
        name: "canonical config accepts agreeing legacy config authorities",
        canonical: "flows",
        legacy: ["flows", "flows"],
        expected: { authority: "canonical", relativePath: "flows" },
      },
      {
        name: "canonical config blocks a disagreeing legacy authority",
        canonical: "specs/canonical",
        legacy: ["specs/legacy", null],
        expected: { blocker: "SPEC_ROOT_CONFLICT" },
      },
      {
        name: "missing canonical config blocks multiple disagreeing legacy authorities",
        canonical: null,
        legacy: ["specs/one", "specs/two"],
        expected: { blocker: "MULTIPLE_LEGACY_SPEC_ROOT_AUTHORITIES" },
      },
      {
        name: "missing canonical config blocks multiple agreeing legacy authorities",
        canonical: null,
        legacy: ["flows", "flows"],
        expected: { blocker: "MULTIPLE_LEGACY_SPEC_ROOT_AUTHORITIES" },
      },
      {
        name: "directory-only legacy remnants use the default root",
        canonical: null,
        legacy: [null, null],
        expected: { authority: "default", relativePath: "specs" },
      },
    ];
    for (const entry of table) {
      const root = createTmpDir("sennel-migration-spec-root-");
      roots.push(root);
      if (entry.canonical !== null) writeJson(root, ".sennel/config.json", { flow: { specDir: entry.canonical } });
      for (const [index, specDir] of entry.legacy.entries()) {
        const directory = index === 0 ? ".senti" : ".senrail";
        if (specDir === null) writeFile(root, `${directory}/placeholder`, "retired directory only\n");
        else writeJson(root, `${directory}/config.json`, { flow: { specDir } });
      }
      const resolved = resolveMigrationSpecRoot(root);
      if (entry.expected.blocker) {
        assert.equal(resolved.blocker.code, entry.expected.blocker, entry.name);
      } else {
        assert.equal(resolved.root.authority, entry.expected.authority, entry.name);
        assert.equal(resolved.root.relativePath, entry.expected.relativePath, entry.name);
      }
    }
  });

  it("runs the public dry-run from the canonical root when legacy directories are only remnants", () => {
    const root = project();
    seedLegacy(root, "515-canonical-authority");
    writeFile(root, ".senti/retired-marker", "no legacy config\n");
    writeFile(root, ".senrail/retired-marker", "no legacy config\n");

    const preview = run(root, ["--dry-run"]);

    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /515-canonical-authority/);
    assert.equal(fs.existsSync(path.join(root, "specs", "515-canonical-authority", "001")), false);
  });
});

describe("migrate specs --to 2", () => {
  it("proof-converts a genuine V1 review, triage, and repair chain through one staged root swap", () => {
    const root = project();
    const id = seedLegacy(root, "515-proven-v1-spec-review");
    const versionDirectory = seedLegacySpecReviewChain(root, id);
    const dryRun = run(root, ["--dry-run"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /proven-converted/);
    assert.equal(fs.existsSync(path.join(versionDirectory, "steps/spec-review/result.json")), true, "dry-run must not mutate a V1 review artifact");

    const crashing = new CanonicalRevisionRootTransaction({
      root,
      specRoot: resolveMigrationSpecRoot(root).root,
      specId: id,
      definition: buildCurrentFlowDefinition(),
      faultInjector({ phase }) {
        if (phase === "source-backed-up") throw new Error("proven review conversion crash");
      },
    });
    assert.throws(() => crashing.apply(), /proven review conversion crash/);
    SpecsMigrationTransaction.recoverAll({ root, specRoot: resolveMigrationSpecRoot(root).root, dryRun: false });

    const review = JSON.parse(fs.readFileSync(path.join(versionDirectory, "revisions", "001", "review.json"), "utf8"));
    assert.equal(review.generation, 3);
    assert.deepEqual(review.audit.map((entry) => entry.stage), ["spec-review", "spec-triage", "spec-repair"]);
    assert.equal(review.findings[0].findingId, "legacy-review-finding");
    assert.equal(review.findings[0].disposition, "invalid");
    for (const legacyPath of ["steps/spec-review/result.json", "steps/spec-triage/result.json", "steps/spec-repair/result.json"]) {
      assert.equal(fs.existsSync(path.join(versionDirectory, legacyPath)), false);
    }
    const catalog = JSON.parse(fs.readFileSync(path.join(versionDirectory, "artifact-catalog.json"), "utf8"));
    assert.equal(catalog.artifacts.some((entry) => ["steps/spec-review/result.json", "steps/spec-triage/result.json", "steps/spec-repair/result.json"].includes(entry.relativePath)), false);
    const report = JSON.parse(fs.readFileSync(path.join(versionDirectory, "artifacts/migration/spec-review-conversion.json"), "utf8"));
    assert.equal(report.classification, "proven-converted");
    const rerun = run(root);
    assert.equal(rerun.status, 0, rerun.stderr);
  });

  it("proves a genuine V1 durable repair audit against the changed current Spec bytes", () => {
    const root = project();
    const id = seedLegacy(root, "515-proven-v1-repair-audit");
    const versionDirectory = seedLegacySpecReviewChain(root, id, { acceptedRepair: true });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(fs.readFileSync(path.join(versionDirectory, "revisions", "001", "review.json"), "utf8"));
    const audit = review.audit.at(-1);
    assert.equal(audit.stage, "spec-repair");
    assert.deepEqual(audit.appliedFindings, ["legacy-review-finding"]);
    assert.equal(audit.acceptedOperations[0].findingIds[0], "legacy-review-finding");
  });

  it("fails closed when a legacy review descriptor claims missing, forged, or wrong-stage Activity provenance", () => {
    for (const [label, activityId] of [
      ["missing", "missing-legacy-review-activity"],
      ["forged", "forged-legacy-review-activity"],
    ]) {
      const root = project();
      const id = `515-${label}-review-activity`;
      seedLegacy(root, id);
      const versionDirectory = seedLegacySpecReviewChain(root, id);
      const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === "steps/spec-review/result.json");
      descriptor.activityId = activityId;
      descriptor.publicationStep = "spec-review";
      descriptor.migrationMaterialization = false;
      fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
      if (label === "forged") {
        const activitiesPath = path.join(versionDirectory, "activities.jsonl");
        fs.appendFileSync(activitiesPath, `${JSON.stringify({ id: activityId, nodeId: "spec-review", type: "result_confirmed", transition: { operation: "confirm_attempt" } })}\n`);
        refreshRawLegacyDescriptor(versionDirectory, "activities.jsonl");
      }
      const result = run(root, ["--dry-run"]);
      assert.equal(result.status, 1, `${label} provenance must block migration`);
      assert.match(result.stderr, /UNPROVABLE_LEGACY_SPEC_REVIEW|UNBOUND_LEGACY_SPEC_REVIEW|INVALID_ACTIVITY_LEDGER/);
      assert.equal(fs.existsSync(path.join(versionDirectory, "revisions")), false);
    }

    const root = project();
    const id = "515-wrong-stage-review-activity";
    seedLegacy(root, id);
    const versionDirectory = seedLegacySpecReviewChain(root, id);
    const state = new CurrentFlowState(JSON.parse(fs.readFileSync(path.join(versionDirectory, "flow.json"), "utf8")), {
      definition: buildCurrentFlowDefinition(),
    });
    const wrongStageActivity = FlowActivity.flowCreated(state, "2026-01-01T00:00:00.000Z");
    const activitiesPath = path.join(versionDirectory, "activities.jsonl");
    fs.writeFileSync(activitiesPath, `${JSON.stringify(wrongStageActivity.toJSON())}\n`);
    refreshRawLegacyDescriptor(versionDirectory, "activities.jsonl");
    const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === "steps/spec-review/result.json");
    descriptor.activityId = wrongStageActivity.id;
    descriptor.publicationStep = "spec-review";
    descriptor.migrationMaterialization = false;
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const result = run(root, ["--dry-run"]);
    assert.equal(result.status, 1, "wrong-stage provenance must block migration");
    assert.match(result.stderr, /UNPROVABLE_LEGACY_SPEC_REVIEW|UNBOUND_LEGACY_SPEC_REVIEW/);
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions")), false);
  });

  it("does not canonicalize a V1 triage permission that is incompatible with its target", () => {
    const root = project();
    const id = "515-invalid-v1-triage-permission";
    seedLegacy(root, id);
    const versionDirectory = seedLegacySpecReviewChain(root, id, { acceptedRepair: true });
    const triagePath = path.join(versionDirectory, "steps/spec-triage/result.json");
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
    triage.items[0].allowedTargets[0].operationKinds = ["replace-array-element"];
    fs.writeFileSync(triagePath, `${JSON.stringify(triage, null, 2)}\n`);
    refreshRawLegacyDescriptor(versionDirectory, "steps/spec-triage/result.json");
    const result = run(root, ["--dry-run"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNPROVABLE_LEGACY_SPEC_REVIEW/);
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions")), false);
  });

  it("does not silently promote raw V2 repair proposals during migration", () => {
    const root = project();
    const id = "515-raw-v2-repair-proposal";
    seedLegacy(root, id);
    const first = runTo(root, 1);
    assert.equal(first.status, 0, first.stderr);
    const versionDirectory = path.join(root, "specs", id, "001");
    const specBytes = fs.readFileSync(path.join(versionDirectory, "spec.json"));
    const identity = {
      specId: id,
      revision: 1,
      digest: crypto.createHash("sha256").update(specBytes).digest("hex"),
      byteLength: specBytes.length,
    };
    const initial = initialCanonicalSpecReview({ specId: id, revision: 1, bytes: specBytes });
    const review = { version: 2, stage: "spec-review", identity, baseReviewDigest: initial.digest, findings: [], operations: [] };
    const reviewed = mergeSpecReviewDelta({
      review: initial,
      delta: new SpecReviewDelta(review),
    });
    const triage = { version: 2, stage: "spec-triage", identity, baseReviewDigest: reviewed.digest, findings: [], operations: [] };
    const triaged = mergeSpecReviewDelta({
      review: reviewed,
      delta: new SpecReviewDelta(triage),
    });
    const repair = {
      version: 2, stage: "spec-repair", identity, baseReviewDigest: triaged.digest, findings: [],
      operations: [{ findingIds: ["forged"], kind: "replace-field", target: { entity: "spec", field: "goal" }, expectedDigest: "0".repeat(64), replacement: "forged", reason: "forged" }],
    };
    writeLegacyReviewDocument(versionDirectory, "steps/spec-review/result.json", review);
    writeLegacyReviewDocument(versionDirectory, "steps/spec-triage/result.json", triage);
    writeLegacyReviewDocument(versionDirectory, "steps/spec-repair/result.json", repair);
    const result = run(root, ["--dry-run"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /raw repair proposals without a command-owned application proof/);
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions")), false);
  });

  it("blocks active and parked unprovable V1 review evidence before dry-run or apply mutates either root", () => {
    for (const lifecycle of ["active", "parked"]) {
      const root = project();
      const id = `515-${lifecycle}-unproven-v1-review`;
      seedLegacy(root, id);
      if (lifecycle === "parked") {
        const flow = legacyFlow(root, id);
        flow.lifecycle = "paused";
        writeLegacyFlow(root, id, flow);
      }
      const versionDirectory = seedLegacySpecReviewChain(root, id, { malformed: true });
      const before = {
        flow: fs.readFileSync(path.join(versionDirectory, "flow.json")),
        spec: fs.readFileSync(path.join(versionDirectory, "spec.json")),
        review: fs.readFileSync(path.join(versionDirectory, "steps/spec-review/result.json")),
        catalog: fs.readFileSync(path.join(versionDirectory, "artifact-catalog.json")),
      };
      const dryRun = run(root, ["--dry-run"]);
      assert.equal(dryRun.status, 1, dryRun.stderr);
      assert.match(dryRun.stderr, /UNPROVABLE_LEGACY_SPEC_REVIEW/);
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "artifact-catalog.json")), before.catalog);
      const applied = run(root);
      assert.equal(applied.status, 1, applied.stderr);
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "flow.json")), before.flow);
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "spec.json")), before.spec);
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "steps/spec-review/result.json")), before.review);
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "artifact-catalog.json")), before.catalog);
      assert.equal(fs.existsSync(path.join(versionDirectory, "revisions")), false);
    }
  });

  it("blocks an active completed spec-review when no legacy review evidence remains", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-active-completed-review-absent");
    const versionDirectory = seedLegacySpecReviewChain(root, id, { malformed: true });
    const removed = ["steps/spec-review/result.json"];
    for (const relativePath of removed) fs.unlinkSync(path.join(versionDirectory, relativePath));
    const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.artifacts = catalog.artifacts.filter((entry) => !removed.includes(entry.relativePath));
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const flowPath = path.join(versionDirectory, "flow.json");
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    const reviewStep = legacyStepLocation(flow.steps, "spec-review");
    reviewStep.node.status = "done";
    const triageStep = legacyStepLocation(flow.steps, "spec-triage");
    triageStep.node.status = "in_progress";
    flow.current = "spec-triage";
    fs.writeFileSync(flowPath, `${JSON.stringify(flow, null, 2)}\n`);
    refreshCatalogDescriptorForBytes(versionDirectory, "flow.json");
    const before = {
      flow: fs.readFileSync(flowPath),
      catalog: fs.readFileSync(catalogPath),
      snapshot: fs.existsSync(path.join(versionDirectory, "revisions", "001", "spec.json")),
    };
    const dryRun = run(root, ["--dry-run"]);
    assert.equal(dryRun.status, 1, dryRun.stderr);
    assert.match(dryRun.stderr, /MISSING_CANONICAL_SPEC_REVIEW/);
    const applied = run(root);
    assert.equal(applied.status, 1, applied.stderr);
    assert.deepEqual(fs.readFileSync(flowPath), before.flow);
    assert.deepEqual(fs.readFileSync(catalogPath), before.catalog);
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions", "001", "spec.json")), before.snapshot);
  });

  it("archives unprovable finalized V1 review evidence with an explicit migration classification", () => {
    const root = project();
    const id = "515-finalized-unproven-v1-review";
    seedLegacy(root, id);
    const source = legacyFlow(root, id);
    source.status = "finalized";
    writeLegacyFlow(root, id, source);
    const versionDirectory = seedLegacySpecReviewChain(root, id, { malformed: true });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    for (const legacyPath of ["steps/spec-review/result.json", "steps/spec-triage/result.json", "steps/spec-repair/result.json"]) {
      assert.equal(fs.existsSync(path.join(versionDirectory, legacyPath)), false);
    }
    assert.equal(fs.existsSync(path.join(versionDirectory, "artifacts/migration/legacy-spec-review/steps/spec-review/result.json")), true);
    const report = JSON.parse(fs.readFileSync(path.join(versionDirectory, "artifacts/migration/spec-review-conversion.json"), "utf8"));
    assert.equal(report.classification, "archived-unproven");
    assert.equal(report.reason, "UNPROVABLE_LEGACY_SPEC_REVIEW");
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions", "001", "review.json")), false);
  });

  it("archives an unbound finalized V1 review without dereferencing a missing descriptor", () => {
    const root = project();
    const id = "515-finalized-unbound-v1-review";
    seedLegacy(root, id);
    const source = legacyFlow(root, id);
    source.status = "finalized";
    writeLegacyFlow(root, id, source);
    const versionDirectory = seedLegacySpecReviewChain(root, id, { malformed: true });
    const catalogPath = path.join(versionDirectory, "artifact-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.artifacts = catalog.artifacts.filter((entry) => entry.relativePath !== "steps/spec-review/result.json");
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(versionDirectory, "artifacts/migration/spec-review-conversion.json"), "utf8"));
    assert.equal(report.sources[0].binding, "unbound");
    assert.equal(fs.existsSync(path.join(versionDirectory, "artifacts/migration/legacy-spec-review/steps/spec-review/result.json")), true);
  });

  it("does not replace direct legacy review evidence with an empty V2 review when its revision proof is absent", () => {
    const root = project();
    const id = seedLegacy(root, "515-direct-unproven-v1-review");
    const reviewPath = path.join(root, "specs", id, "spec-review.json");
    writeJson(root, `specs/${id}/spec-review.json`, {
      version: 1,
      phase: "spec",
      generatedAt: "2026-08-29T00:00:00.000Z",
      verdict: "PASS",
      counts: { blocking: 0, nonBlocking: 0, total: 0 },
      blockingFindings: [],
      nonBlockingImprovements: [],
    });
    const before = fs.readFileSync(reviewPath);
    const dryRun = run(root, ["--dry-run"]);
    assert.equal(dryRun.status, 1, dryRun.stderr);
    assert.match(dryRun.stderr, /UNPROVABLE_LEGACY_SPEC_REVIEW/);
    assert.deepEqual(fs.readFileSync(reviewPath), before);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    const applied = run(root);
    assert.equal(applied.status, 1, applied.stderr);
    assert.deepEqual(fs.readFileSync(reviewPath), before);
  });

  it("archives direct finalized legacy review evidence beside an explicit V2 conversion report", () => {
    const root = project();
    const id = seedLegacy(root, "515-direct-finalized-v1-review");
    const source = legacyFlow(root, id);
    source.status = "finalized";
    writeLegacyFlow(root, id, source);
    writeJson(root, `specs/${id}/spec-review.json`, {
      version: 1,
      phase: "spec",
      generatedAt: "2026-08-29T00:00:00.000Z",
      verdict: "PASS",
      counts: { blocking: 0, nonBlocking: 0, total: 0 },
      blockingFindings: [],
      nonBlockingImprovements: [],
    });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const versionDirectory = path.join(root, "specs", id, "001");
    assert.equal(fs.existsSync(path.join(versionDirectory, "spec-review.json")), false);
    assert.equal(fs.existsSync(path.join(versionDirectory, "artifacts/migration/legacy-files/spec-review.json")), true);
    const report = JSON.parse(fs.readFileSync(path.join(versionDirectory, "artifacts/migration/spec-review-conversion.json"), "utf8"));
    assert.equal(report.classification, "archived-unproven");
    assert.equal(fs.existsSync(path.join(versionDirectory, "revisions/001/review.json")), false);
  });

  it("classifies, atomically upgrades, recovers, and reruns every canonical Version in one Spec root", () => {
    const root = project();
    const id = seedLegacy(root, "515-multi-version-revision-root");
    const first = runTo(root, 1);
    assert.equal(first.status, 0, first.stderr);
    const specDirectory = path.join(root, "specs", id);
    fs.cpSync(path.join(specDirectory, "001"), path.join(specDirectory, "002"), { recursive: true, verbatimSymlinks: true });
    const secondDirectory = path.join(specDirectory, "002");
    const secondFlow = JSON.parse(fs.readFileSync(path.join(secondDirectory, "flow.json"), "utf8"));
    secondFlow.flowId = `${secondFlow.flowId}-v2`;
    secondFlow.flowVersionId = `${secondFlow.flowVersionId}-v2`;
    secondFlow.runId = `${secondFlow.runId}-v2`;
    fs.writeFileSync(path.join(secondDirectory, "flow.json"), `${JSON.stringify(secondFlow, null, 2)}\n`);
    refreshCatalogDescriptorForBytes(secondDirectory, "flow.json");

    const preview = run(root, ["--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /versioned-v1-to-v2/);
    assert.match(preview.stdout, /"001","002"/);

    const crashing = new CanonicalRevisionRootTransaction({
      root,
      specRoot: resolveMigrationSpecRoot(root).root,
      specId: id,
      definition: buildCurrentFlowDefinition(),
      faultInjector({ phase }) {
        if (phase === "source-backed-up") throw new Error("simulated revision-root crash");
      },
    });
    assert.throws(() => crashing.apply(), /simulated revision-root crash/);
    const recovery = SpecsMigrationTransaction.recoverAll({
      root,
      specRoot: resolveMigrationSpecRoot(root).root,
      dryRun: true,
    });
    assert.equal(recovery[0].requiresRecovery, true);
    const recovered = SpecsMigrationTransaction.recoverAll({
      root,
      specRoot: resolveMigrationSpecRoot(root).root,
      dryRun: false,
    });
    assert.equal(recovered[0].recovered, "placed-staging");

    for (const version of ["001", "002"]) {
      const versionDirectory = path.join(specDirectory, version);
      const rootBytes = fs.readFileSync(path.join(versionDirectory, "spec.json"));
      assert.deepEqual(fs.readFileSync(path.join(versionDirectory, "revisions", "001", "spec.json")), rootBytes);
      assert.equal(fs.existsSync(path.join(versionDirectory, "revisions", "001", "review.json")), false,
        "snapshot-only pre-review Version must remain a valid V2 no-op on rerun");
    }
    const rerun = run(root);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(rerun.stdout, "migrate specs reached revision 2\n");
  });

  it("plans without writes, atomically replaces the legacy root, and leaves a production-readable historical Version", () => {
    const root = project();
    const id = seedLegacy(root);
    const before = fs.readFileSync(path.join(root, "specs", id, "flow.json"), "utf8");

    const preview = run(root, ["--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /CANONICAL_HISTORICAL_FLOW_STATE/);
    assert.equal(fs.readFileSync(path.join(root, "specs", id, "flow.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-specs")), false);

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stdout, "migrate specs reached revision 2\n");
    const version = path.join(root, "specs", id, "001");
    assert.equal(fs.existsSync(path.join(root, "specs", id, "flow.json")), false);
    assert.equal(fs.existsSync(path.join(version, "flow.json")), true);
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/flow.legacy.json")), true);
    assert.equal(fs.existsSync(path.join(version, "issue.md")), true);
    assert.equal(fs.existsSync(path.join(version, "artifacts/tests/sample.test.js")), true);
    assert.equal(fs.existsSync(path.join(version, "steps/test-execute/output.log")), true);
    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    assert.deepEqual(Object.keys(report).sort(), [
      "schemaRevision", "migration", "sourceFiles", "target", "converted", "preserved", "omitted",
      "relocatedTransient", "missingTransient", "generated",
    ].sort());
    assert.equal(report.migration.sourceFormat.family, "flat-steps");
    assert.equal(report.migration.fieldCoverage.atomicPointers > 0, true);
    assert.equal(
      Object.values(report.migration.fieldCoverage.classifications).reduce((total, count) => total + count, 0),
      report.migration.fieldCoverage.atomicPointers,
    );
    assert.ok(report.converted.some((entry) => entry.source === "flow.json" && entry.pointer === "/steps/0/id"));
    assert.equal(report.converted.some((entry) => entry.source === "flow.json" && entry.pointer === "/steps"), false);
    assert.equal(report.preserved.some((entry) => entry.source === "flow.json" && entry.pointer === null), false);
    const flowSource = report.sourceFiles.find((entry) => entry.path === "flow.json");
    assert.deepEqual(
      report.generated.find((entry) => entry.target === "artifacts/migration/flow.legacy.json"),
      {
        target: "artifacts/migration/flow.legacy.json",
        reason: "RAW_LEGACY_FLOW_AUTHORITY",
        inputs: [{ source: "flow.json", pointer: "", hash: flowSource.hash }],
      },
    );
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/spec.legacy.json")), false);
    assert.deepEqual(
      report.generated.map((entry) => entry.target).sort(),
      ["activities.jsonl", "artifact-catalog.json", "artifacts/migration/flow.legacy.json", "flow-migration-report.json"],
    );

    const store = new CurrentFlowVersionStore({
      location: new FlowVersionLocation({
        repositoryRoot: root,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: "specs",
        specId: id,
        version: 1,
      }),
      definition: buildCurrentFlowDefinition(),
    });
    const state = store.load();
    assert.equal(state.history.kind, "historical");
    assert.equal(state.history.execution, "dormant");
    assert.equal(state.current.at(-1), "T-1");
    assert.equal(state.nextAction(), null);

    const rerun = run(root);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(rerun.stdout, "migrate specs reached revision 2\n");
  });

  it("leaves an unrecognized source untouched and makes the command incomplete", () => {
    const root = project();
    const id = seedLegacy(root, "515-unknown-artifact");
    const unknown = "do not guess\n";
    writeFile(root, `specs/${id}/unrecognized.bin`, unknown);
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNKNOWN_ARTIFACT/);
    const fingerprint = result.stderr.match(/shape fingerprint: ([a-f0-9]{64})/)?.[1] ?? null;
    assert.ok(fingerprint);
    const repeat = run(root);
    assert.equal(repeat.stderr.match(/shape fingerprint: ([a-f0-9]{64})/)?.[1], fingerprint);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "flow.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    assert.equal(fs.readFileSync(path.join(root, "specs", id, "unrecognized.bin"), "utf8"), unknown);
  });

  it("fails closed on an unknown legacy Flow field with a deterministic structural fingerprint", () => {
    const root = project();
    const id = seedLegacy(root, "515-unknown-flow-field");
    const flow = legacyFlow(root, id);
    flow.unrecognizedField = { beta: ["value"], alpha: { count: 1 } };
    writeLegacyFlow(root, id, flow);
    const before = fs.readFileSync(path.join(root, "specs", id, "flow.json"), "utf8");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNKNOWN_FLOW_FIELD/);
    assert.match(result.stderr, /\/unrecognizedField/);
    const fingerprint = result.stderr.match(/shape fingerprint: ([a-f0-9]{64})/)?.[1] ?? null;
    assert.ok(fingerprint);
    assert.equal(run(root).stderr.match(/shape fingerprint: ([a-f0-9]{64})/)?.[1], fingerprint);
    assert.equal(fs.readFileSync(path.join(root, "specs", id, "flow.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
  });

  it("classifies every Spec before apply and continues with independent valid candidates", () => {
    const root = project();
    const valid = seedLegacy(root, "515-valid-beside-blocked");
    const blocked = seedLegacy(root, "515-blocked-beside-valid");
    const sourceFlow = fs.readFileSync(path.join(root, "specs", blocked, "flow.json"), "utf8");
    writeFile(root, `specs/${blocked}/unknown.bin`, "must not be guessed\n");

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNKNOWN_ARTIFACT/);
    assert.equal(fs.existsSync(path.join(root, "specs", valid, "001", "flow.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", blocked, "001")), false);
    assert.equal(fs.readFileSync(path.join(root, "specs", blocked, "flow.json"), "utf8"), sourceFlow);
    assert.equal(fs.readFileSync(path.join(root, "specs", blocked, "unknown.bin"), "utf8"), "must not be guessed\n");
  });

  it("keeps specs and layout revisions independent when specs run first", () => {
    const root = createTmpDir("sennel-specs-before-layout-");
    roots.push(root);
    writeJson(root, ".senti/config.json", { flow: { specDir: "specs" } });
    const id = seedLegacy(root, "515-independent-revisions");

    const specs = run(root);
    assert.equal(specs.status, 0, specs.stderr || specs.stdout);
    assert.equal(fs.existsSync(path.join(root, ".sennel")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-specs")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001", "flow.json")), true);

    const layout = runLayout(root);
    assert.equal(layout.status, 0, layout.stderr || layout.stdout);
    assert.equal(fs.existsSync(path.join(root, ".senti")), false);
    assert.equal(fs.existsSync(path.join(root, ".sennel", "config.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001", "flow.json")), true);
  });

  it("keeps an imported historical cursor readable but refuses unsupported continuation before an Activity write", () => {
    const root = project();
    const id = seedContinuableLegacy(root);
    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const store = new CurrentFlowVersionStore({
      location: new FlowVersionLocation({
        repositoryRoot: root,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: "specs",
        specId: id,
        version: 1,
      }),
      definition: buildCurrentFlowDefinition(),
    });
    const state = store.load();
    assertDormantHistoricalContinuationRefused(store, state, startActivity(state));
  });

  it("preserves active blocked, parked, finalized, and archived historical lifecycle semantics", () => {
    const root = project();
    const fixtures = [
      {
        id: "515-active-blocked",
        flow: {
          request: "Keep a blocked historical condition.",
          lifecycle: "active",
          status: "failed",
          steps: [{ id: "blocked-condition", status: "failed" }],
          tasks: [],
          state: {},
        },
        lifecycle: "active",
        status: "failed",
        current: null,
        node: ["blocked-condition", "failed"],
      },
      {
        id: "515-paused-history",
        flow: {
          request: "Keep a parked historical cursor.",
          lifecycle: "paused",
          steps: [{ id: "paused-step", status: "in_progress" }],
          tasks: [],
          currentTaskId: "paused-step",
          state: {},
        },
        lifecycle: "parked",
        status: "in_progress",
        current: "paused-step",
        node: ["paused-step", "in_progress"],
      },
      {
        id: "515-finalized-history",
        flow: {
          request: "Durable finalization wins over the old controller lifecycle.",
          lifecycle: "active",
          steps: [{ id: "final-step", status: "in_progress" }],
          tasks: [],
          currentTaskId: "final-step",
          state: { finalizedAt: "2026-01-04T00:00:00.000Z" },
        },
        lifecycle: "finalized",
        status: "done",
        current: null,
        node: ["final-step", "in_progress"],
      },
      {
        id: "515-archived-history",
        flow: {
          request: "Preserve the archived root status.",
          status: "archived",
          steps: [{ id: "archived-step", status: "archived" }],
          tasks: [],
          state: {},
        },
        lifecycle: "finalized",
        status: "archived",
        current: null,
        node: ["archived-step", "archived"],
      },
    ];
    for (const fixture of fixtures) {
      const base = `specs/${fixture.id}`;
      writeJson(root, `${base}/flow.json`, { spec: `${base}/spec.json`, ...fixture.flow });
      writeJson(root, `${base}/spec.json`, { title: fixture.id, tasks: [] });
    }

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    for (const fixture of fixtures) {
      const state = versionStore(root, fixture.id).load();
      assert.equal(state.lifecycle.state, fixture.lifecycle, fixture.id);
      assert.equal(state.root.status, fixture.status, fixture.id);
      assert.equal(state.current?.at(-1) ?? null, fixture.current, fixture.id);
      assert.equal(state.findNode(fixture.node[0]).status, fixture.node[1], fixture.id);
      assert.equal(state.history.kind, "historical", fixture.id);
    }
    const finalized = versionStore(root, "515-finalized-history").load();
    assert.equal(finalized.nextAction(), null);
    assert.throws(() => finalized.park(), /only an active Flow may be parked/);
    const report = JSON.parse(fs.readFileSync(
      path.join(root, "specs", "515-finalized-history", "001", "flow-migration-report.json"),
      "utf8",
    ));
    assert.equal(report.preserved.some((entry) => (
      entry.source === "flow.json" && entry.pointer === "/lifecycle" && entry.reason === "SUPERSEDED_BY_DURABLE_FINALIZATION"
    )), true);
    assert.equal(report.preserved.some((entry) => (
      entry.source === "flow.json" && entry.pointer === "/currentTaskId" && entry.reason === "SUPERSEDED_BY_DURABLE_FINALIZATION"
    )), true);
  });

  it("records trusted creation provenance as the first canonical flow_created Activity without inventing unavailable creation", () => {
    const root = project();
    const trustedId = seedContinuableLegacy(root, "515-trusted-creation");
    const unavailableId = seedContinuableLegacy(root, "515-unavailable-creation");
    const trusted = legacyFlow(root, trustedId);
    trusted.createdAt = "2026-01-01T03:04:05.000Z";
    writeLegacyFlow(root, trustedId, trusted);

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const trustedStore = versionStore(root, trustedId);
    const trustedState = trustedStore.load();
    const trustedActivities = trustedStore.activities();
    assert.equal(trustedState.history.creation.status, "available");
    assert.deepEqual(trustedState.history.creation.source, {
      path: "flow.json",
      pointer: "/createdAt",
      hash: JSON.parse(fs.readFileSync(path.join(root, "specs", trustedId, "001", "flow-migration-report.json"), "utf8"))
        .sourceFiles.find((entry) => entry.path === "flow.json").hash,
      timestamp: "2026-01-01T03:04:05.000Z",
    });
    assert.equal(trustedActivities[0].type, "flow_created");
    assert.equal(trustedActivities[0].transition.operation, "create_flow");
    assert.equal(trustedActivities.some((entry) => (
      entry.type === "flow_created" && entry.transition.operation === "create_flow"
    )), true);
    assert.equal(trustedActivities[0].timing.startedAt, "2026-01-01T03:04:05.000Z");
    assert.equal(trustedActivities[0].references.artifacts.length, 1);
    const creationEvidencePath = trustedActivities[0].references.artifacts[0].id;
    assert.match(creationEvidencePath, /^steps\/system\/activity-evidence\/[a-f0-9]{64}\.json$/);
    const creationEvidence = JSON.parse(fs.readFileSync(
      path.join(root, "specs", trustedId, "001", creationEvidencePath),
      "utf8",
    ));
    assert.equal(creationEvidence.activityId, trustedActivities[0].id);
    assert.deepEqual(creationEvidence.owner, { nodeId: "flow", nodeKey: "flow" });
    assert.deepEqual(creationEvidence.source, {
      path: "flow.json",
      pointer: "/createdAt",
      hash: trustedState.history.creation.source.hash,
    });
    const trustedCatalog = JSON.parse(fs.readFileSync(path.join(root, "specs", trustedId, "001", "artifact-catalog.json"), "utf8"));
    assert.equal(trustedCatalog.artifacts.find((entry) => entry.relativePath === creationEvidencePath).activityId, trustedActivities[0].id);
    assert.equal(trustedState.confirmationOrder, 1);

    const unavailableStore = versionStore(root, unavailableId);
    const unavailableState = unavailableStore.load();
    assert.deepEqual(unavailableState.history.creation.toJSON(), {
      status: "unavailable",
      reason: "NO_TRUSTED_CREATION_EVIDENCE",
    });
    const unavailableActivities = unavailableStore.activities();
    assert.equal(unavailableActivities.some((entry) => entry.type === "flow_created"), false);
    assert.equal(unavailableActivities.some((entry) => entry.transition.operation === "create_flow"), false);
    assert.equal(unavailableActivities.flatMap((entry) => entry.references.artifacts).length, 0);

    createExistingVersion(root, "515-fresh-creation", {
      flowId: "fresh-flow-creation",
      flowVersionId: "fresh-flow-version-creation",
      runId: "fresh-run-creation",
    });
    const freshStore = versionStore(root, "515-fresh-creation");
    assert.equal(freshStore.load().history, null);
    const freshActivities = freshStore.activities();
    assert.equal(freshActivities[0].type, "flow_created");
    assert.equal(freshActivities[0].transition.operation, "create_flow");
    assert.equal(freshActivities.some((entry) => (
      entry.type === "flow_created" && entry.transition.operation === "create_flow"
    )), true);
    assert.equal(freshActivities[0].references.artifacts.length, 0);
  });

  it("preserves the production nonblocking policy and rejects conflicting historical current cursors without writes", () => {
    const root = project();
    const validId = seedContinuableLegacy(root, "515-nonblocking-policy");
    const valid = legacyFlow(root, validId);
    valid.nonblocking = {
      enabled: true,
      activatedAt: "2026-01-02T00:00:00.000Z",
      activatedStep: "branch",
      reason: "Acceptance-backed advisory continuation",
    };
    writeLegacyFlow(root, validId, valid);

    const multipleId = seedLegacy(root, "515-multiple-current");
    const multiple = legacyFlow(root, multipleId);
    multiple.steps[1].status = "in_progress";
    writeLegacyFlow(root, multipleId, multiple);
    const explicitId = seedLegacy(root, "515-explicit-current-conflict");
    const explicit = legacyFlow(root, explicitId);
    explicit.steps[0].status = "in_progress";
    explicit.currentTaskId = "T-1";
    explicit.tasks[0].steps[1].status = "pending";
    writeLegacyFlow(root, explicitId, explicit);
    const multipleBefore = fs.readFileSync(path.join(root, "specs", multipleId, "flow.json"), "utf8");
    const explicitBefore = fs.readFileSync(path.join(root, "specs", explicitId, "flow.json"), "utf8");

    const applied = run(root);
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /CONFLICTING_CURRENT_CURSOR/);
    assert.deepEqual(versionStore(root, validId).load().policy.nonblocking.toJSON(), valid.nonblocking);
    assert.equal(fs.existsSync(path.join(root, "specs", multipleId, "001")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", explicitId, "001")), false);
    assert.equal(fs.readFileSync(path.join(root, "specs", multipleId, "flow.json"), "utf8"), multipleBefore);
    assert.equal(fs.readFileSync(path.join(root, "specs", explicitId, "flow.json"), "utf8"), explicitBefore);
  });

  it("maps complete nested runtime logs to ordered direct Activities and preserves incomplete evidence", () => {
    const root = project();
    const completeId = seedLegacy(root, "515-nested-runtime-log");
    const complete = legacyFlow(root, completeId);
    complete.tasks[0].steps[1].id = "task-impl";
    complete.tasks[0].steps[1].startedAt = "2026-01-02T13:00:00.000Z";
    complete.tasks[0].steps[1].finishedAt = "2026-01-02T14:00:00.000Z";
    complete.tasks[0].steps[1].runtimeLog = {
      runId: "legacy-runtime-1",
      sequence: 2,
      attempt: 1,
      command: "npm test",
      startedAt: "2026-01-02T13:00:00.000Z",
      endedAt: "2026-01-02T23:00:00.000+09:00",
      exitCode: 0,
    };
    complete.directIntegrationReceipt = { integratedAt: "2026-01-02T15:00:00.000Z" };
    writeLegacyFlow(root, completeId, complete);

    const incompleteId = seedLegacy(root, "515-incomplete-runtime-log");
    const incomplete = legacyFlow(root, incompleteId);
    incomplete.tasks[0].steps[1].id = "task-impl";
    incomplete.tasks[0].steps[1].runtimeLog = { runId: "legacy-runtime-incomplete" };
    writeLegacyFlow(root, incompleteId, incomplete);
    const incompleteCandidate = plannedCandidate(root, incompleteId).candidate;
    const completeFlowHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(root, "specs", completeId, "flow.json")))
      .digest("hex");

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const completeStore = versionStore(root, completeId);
    const activities = completeStore.activities();
    assert.deepEqual(activities.map((entry) => entry.nodeId), ["T-1-impl", "flow"]);
    assert.equal(activities[0].timing.finishedAt, "2026-01-02T23:00:00.000+09:00");
    const runtimeEvidencePath = activities[0].references.artifacts[0].id;
    assert.match(runtimeEvidencePath, /^steps\/impl\/T-1\/impl\/activity-evidence\/[a-f0-9]{64}\.json$/);
    const runtimeEvidence = JSON.parse(fs.readFileSync(path.join(root, "specs", completeId, "001", runtimeEvidencePath), "utf8"));
    // The canonical Task node key comes from the production definition; the
    // source-only `task-impl` label is not an authority identity.
    assert.deepEqual(runtimeEvidence.owner, { nodeId: "T-1-impl", nodeKey: "impl" });
    assert.deepEqual(runtimeEvidence.source, {
      path: "flow.json",
      pointer: "/tasks/0/steps/1/runtimeLog/endedAt",
      hash: completeFlowHash,
    });
    assert.equal(runtimeEvidence.activityId, activities[0].id);
    const catalog = JSON.parse(fs.readFileSync(path.join(root, "specs", completeId, "001", "artifact-catalog.json"), "utf8"));
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === runtimeEvidencePath);
    assert.equal(descriptor.logicalKey, "activity.evidence");
    assert.equal(descriptor.activityId, activities[0].id);
    assert.equal(descriptor.hash, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "specs", completeId, "001", runtimeEvidencePath))).digest("hex"));
    const report = JSON.parse(fs.readFileSync(path.join(root, "specs", completeId, "001", "flow-migration-report.json"), "utf8"));
    assert.equal(report.converted.some((entry) => entry.pointer === "/tasks/0/steps/1/runtimeLog/endedAt"), true);
    assert.equal(report.preserved.some((entry) => (
      entry.pointer === "/tasks/0/steps/1/runtimeLog/runId" && entry.reason === "DIRECT_RUNTIME_LOG_AUXILIARY_FACT"
    )), true);
    assert.equal(report.preserved.some((entry) => entry.pointer === "/tasks/0/steps/1/startedAt"), true);
    assert.equal(report.preserved.some((entry) => entry.pointer === "/tasks/0/steps/1/finishedAt"), true);
    assert.equal(incompleteCandidate.fieldManifest.entries.every((entry) => typeof entry.pointer === "string"), true);
    const incompleteReport = JSON.parse(fs.readFileSync(path.join(root, "specs", incompleteId, "001", "flow-migration-report.json"), "utf8"));
    assert.equal(incompleteReport.preserved.some((entry) => (
      entry.pointer === "/tasks/0/steps/1/runtimeLog" && entry.reason === "INSUFFICIENT_EVENT_DETAIL"
    )), true);
    assert.equal(versionStore(root, incompleteId).activities().length, 0);
  });

  it("keeps a legacy historical Step runtime observation under its exact typed historical owner", () => {
    for (const historicalId of ["review-draft-questions", "legacy-review"]) {
      const root = project();
      const id = seedContinuableLegacy(root, `515-historical-runtime-owner-${historicalId}`);
      const flow = legacyFlow(root, id);
      // Older producers named static Steps differently from the current
      // definition. Even a suffix which resembles a Task review leaf retains
      // its exact historical identity; it must not create a fake Task owner.
      flow.steps = [{
        id: historicalId,
        status: "done",
        runtimeLog: {
          runId: "historical-review-run",
          sequence: 1,
          attempt: 1,
          command: "flow run review",
          startedAt: "2026-01-02T13:00:00.000Z",
          endedAt: "2026-01-02T13:01:00.000Z",
          exitCode: 0,
        },
      }];
      delete flow.currentTaskId;
      writeLegacyFlow(root, id, flow);

      const applied = run(root);
      assert.equal(applied.status, 0, applied.stderr);
      const store = versionStore(root, id);
      assert.equal(store.load().findNode(historicalId).key, historicalId);
      const [activity] = store.activities();
      assert.equal(activity.nodeId, historicalId);
      const evidencePath = activity.references.artifacts[0].id;
      assert.match(evidencePath, new RegExp(`^steps/historical/${historicalId}/activity-evidence/[a-f0-9]{64}\\.json$`));
      const evidence = JSON.parse(fs.readFileSync(path.join(root, "specs", id, "001", evidencePath), "utf8"));
      assert.deepEqual(evidence.owner, { nodeId: historicalId, nodeKey: historicalId });
      const catalog = JSON.parse(fs.readFileSync(path.join(root, "specs", id, "001", "artifact-catalog.json"), "utf8"));
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === evidencePath);
      assert.equal(descriptor.publicationStep, "system");
      assert.equal(descriptor.activityId, activity.id);
    }
  });

  it("normalizes legacy Task child identities while preserving direct status and result facts", () => {
    const root = project();
    const id = "515-task-child-state";
    const base = `specs/${id}`;
    const result = {
      outcome: "passed",
      summary: "direct legacy result",
      confirmedAt: "2026-01-02T00:00:00.000Z",
      artifactRefs: [],
    };
    writeJson(root, `${base}/flow.json`, {
      spec: `${base}/spec.json`,
      tasks: [{
        id: "T-1",
        status: "in_progress",
        steps: [
          { id: "T-1-task-impl", status: "done", result },
          { id: "T-1-task-review", status: "in_progress" },
          { id: "T-1-task-gate", status: "pending" },
        ],
      }],
      currentTaskId: "T-1-task-review",
    });
    writeJson(root, `${base}/spec.json`, { title: "Task child fixture", tasks: [{ id: "T-1" }] });
    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const state = new CurrentFlowVersionStore({
      location: new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId: id, version: 1 }),
      definition: buildCurrentFlowDefinition(),
    }).load();
    const impl = state.findNode("T-1-impl");
    assert.equal(impl.status, "done");
    assert.deepEqual(impl.result.toJSON(), result);
    assert.equal(state.current.at(-1), "T-1-review");
  });

  it("projects only legacy task instructions into an absent Spec task authority and classifies historical producer fields", () => {
    const root = project();
    const id = "515-task-spec-authority";
    const base = `specs/${id}`;
    writeJson(root, `${base}/flow.json`, {
      spec: `${base}/spec.json`,
      tasks: [{
        id: "T-legacy",
        key: "legacy-key",
        title: "Instruction title",
        goal: "Instruction goal",
        spec: "Instruction spec",
        requirements: ["R-1"],
        summary: "Instruction summary",
        parent: "T-parent",
        origin: "legacy-import",
        added_round: 3,
        status: "done",
        startedAt: "2026-01-02T00:00:00.000Z",
        finishedAt: "2026-01-02T01:00:00.000Z",
        runtimeLog: { runId: "incomplete" },
        steps: [{ id: "task-impl", status: "done" }],
      }],
      steps: [],
      state: {},
      childId: "retired-child-id",
      runtimeLog: { runId: "root-incomplete" },
      workerArtifactReceipts: [{ stepId: "impl", consumedAt: "2026-01-02T00:00:00.000Z" }],
      testReviewRepairHistory: [{ completion: "legacy" }],
      expandedPluginHooks: [{ hook: "preflight" }],
      hooks: [{ name: "legacy-hook" }],
    });
    writeJson(root, `${base}/spec.json`, {
      title: "Existing Spec fields remain authoritative",
      userExtension: { keep: true },
    });

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    const spec = JSON.parse(fs.readFileSync(path.join(version, "spec.json"), "utf8"));
    assert.equal(spec.specId, id);
    assert.deepEqual(spec.userExtension, { keep: true });
    assert.deepEqual(spec.tasks, [{
      id: "T-legacy",
      key: "legacy-key",
      title: "Instruction title",
      goal: "Instruction goal",
      spec: "Instruction spec",
      requirements: ["R-1"],
      summary: "Instruction summary",
      parent: "T-parent",
      origin: "legacy-import",
      added_round: 3,
    }]);
    assert.equal(Object.hasOwn(spec.tasks[0], "status"), false);
    assert.equal(Object.hasOwn(spec.tasks[0], "steps"), false);
    assert.equal(Object.hasOwn(spec.tasks[0], "runtimeLog"), false);
    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    assert.equal(report.converted.some((entry) => (
      entry.source === "flow.json" && entry.pointer === "/tasks/0/title" && entry.destination === "spec.json"
    )), true);
    assert.equal(report.converted.some((entry) => (
      entry.source === "flow.json" && entry.pointer === "/tasks/0/status" && entry.destination === "flow.json"
    )), true);
    for (const pointer of [
      "/tasks/0/startedAt",
      "/tasks/0/finishedAt",
      "/tasks/0/runtimeLog",
      "/childId",
      "/runtimeLog/runId",
      "/workerArtifactReceipts/0/stepId",
      "/testReviewRepairHistory/0/completion",
      "/expandedPluginHooks/0/hook",
      "/hooks/0/name",
    ]) {
      assert.equal(report.preserved.some((entry) => entry.source === "flow.json" && entry.pointer === pointer), true, pointer);
    }
  });

  it("adapts root, attempt, review-evidence, and Task artifact roles without dropping direct evidence", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-artifact-adapters");
    const base = `specs/${id}`;
    const reviewDigest = "a".repeat(64);
    const issueLog = { entries: [{ code: "DIRECT" }] };
    const fileMap = { mappings: [{ requirement: "R-1", file: "src/example.js" }] };
    const review = { verdict: "pass", direct: true };
    const triage = { disposition: "repair" };
    const repair = { repaired: true };
    const testResult = { passed: true };
    writeJson(root, `${base}/issue-log.json`, issueLog);
    writeFile(root, `${base}/issue.md`, "# Snapshot without a linked issue\n");
    writeJson(root, `${base}/file-map.json`, fileMap);
    writeJson(root, `${base}/impl-review.json`, review);
    writeJson(root, `${base}/impl-triage.json`, triage);
    writeJson(root, `${base}/impl-repair.json`, repair);
    writeJson(root, `${base}/test-execute-result.json`, testResult);
    writeJson(root, `${base}/review-evidence/${reviewDigest}.json`, {
      phase: "impl",
      taskId: null,
      provenance: { capturedAt: "2026-01-03T00:00:00.000Z" },
    });
    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "issue-log.json"), "utf8")), issueLog);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "steps/impl/file-map.json"), "utf8")), fileMap);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "steps/impl/review/result.json"), "utf8")).attempts[0].detail, review);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "steps/impl/triage/result.json"), "utf8")), triage);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "steps/impl/repair/result.json"), "utf8")), repair);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(version, "steps/test-execute/result.json"), "utf8")).attempts[0].detail, testResult);
    assert.equal(fs.existsSync(path.join(version, `steps/impl/review/evidence/${reviewDigest}.json`)), true);
    const activities = fs.readFileSync(path.join(version, "activities.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].transition.operation, "record_note");
    assert.equal(activities[0].nodeId, "impl-review");
    const state = new CurrentFlowVersionStore({
      location: new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId: id, version: 1 }),
      definition: buildCurrentFlowDefinition(),
    }).load();
    assert.equal(state.issue, null);
    assert.equal(state.confirmationOrder, 1);
  });

  it("records a producer-declared missing transient raw log and preserves its regeneration provenance without blocking apply", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-missing-transient-log");
    const base = `specs/${id}`;
    const result = {
      verdict: "PASS",
      raw_output_path: "tests/.raw/test-execution.log",
      artifactRefs: [{ kind: "artifact", path: "file-map.json" }],
    };
    writeJson(root, `${base}/file-map.json`, { mappings: [{ requirement: "R-1", file: "src/example.js" }] });
    writeJson(root, `${base}/test-execute-result.json`, result);
    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    const resultSource = report.sourceFiles.find((entry) => entry.path === "test-execute-result.json");
    assert.deepEqual(report.missingTransient, [{
      source: "tests/.raw/test-execution.log",
      pointer: null,
      destination: "steps/test-execute/output.log",
      reason: "REFERENCED_TRANSIENT_RAW_LOG_MISSING",
      regenerationSource: {
        source: "test-execute-result.json",
        pointer: "/raw_output_path",
        hash: resultSource.hash,
      },
    }]);
    assert.equal(fs.existsSync(path.join(version, "steps", "test-execute", "output.log")), false);
    const canonicalResult = JSON.parse(fs.readFileSync(path.join(version, "steps", "test-execute", "result.json"), "utf8"));
    assert.equal(canonicalResult.attempts[0].detail.artifactRefs[0].path, "steps/impl/file-map.json");
    assert.equal(canonicalResult.attempts[0].detail.raw_output_path, "tests/.raw/test-execution.log");
  });

  it("classifies source-era runtime residue by typed path grammar without capturing durable user evidence", () => {
    const classifier = new LegacyRuntimeResidueClassifier();
    const table = [
      ["tests/.raw/test-execution.log", "LEGACY_RAW_LOG_RESIDUE"],
      [".sennel/handoffs/run/request.json", "LEGACY_WORKER_HANDOFF_RESIDUE"],
      [".runtime/retry-recovery/transaction.json", "LEGACY_RUNTIME_WORKSPACE_RESIDUE"],
      ["tmp/session.tmp", "LEGACY_RUNTIME_WORKSPACE_RESIDUE"],
      ["cache/compiled.cache", "LEGACY_RUNTIME_WORKSPACE_RESIDUE"],
      ["review-history/work-units/impl.json", "LEGACY_WORK_UNIT_RESIDUE"],
      ["upgrade.log", "LEGACY_UPGRADE_LOG_RESIDUE"],
      [".flow.json.writer.worker.owner.tmp", "LEGACY_TEMPORARY_FILE_RESIDUE"],
      [".issue-log.lock", "LEGACY_LOCK_RESIDUE"],
      ["completed-transaction.json", "LEGACY_TRANSACTION_JOURNAL_RESIDUE"],
      ["interrupted-journal.json", "LEGACY_TRANSACTION_JOURNAL_RESIDUE"],
      ["requirement-summary.json", "LEGACY_RAW_SUMMARY_RESIDUE"],
      ["finalize-cleanup.json", "LEGACY_FINALIZE_RUNTIME_RESIDUE"],
    ];
    for (const [sourcePath, reason] of table) {
      assert.equal(classifier.classify(sourcePath)?.reason, reason, sourcePath);
    }
    for (const sourcePath of ["operator-notes.log", "architecture-record.json"]) {
      assert.equal(classifier.classify(sourcePath), null, sourcePath);
    }
  });

  it("isolates source-era runtime residue without cataloging or reviving it as live runtime control input", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-runtime-residue");
    const base = `specs/${id}`;
    const residues = [
      [".retry-recovery.transaction.json", "retry transaction\n", 0o640, "LEGACY_TRANSACTION_JOURNAL_RESIDUE"],
      [".sennel/handoffs/run/request.json", "handoff request\n", 0o600, "LEGACY_WORKER_HANDOFF_RESIDUE"],
      [".issue-log.lock", "legacy lock\n", 0o600, "LEGACY_LOCK_RESIDUE"],
      [".flow.json.writer.worker.owner.tmp", "owner marker\n", 0o644, "LEGACY_TEMPORARY_FILE_RESIDUE"],
      ["review-history/work-units/impl.json", "work unit\n", 0o640, "LEGACY_WORK_UNIT_RESIDUE"],
      ["finalize-cleanup.json", "finalize journal\n", 0o600, "LEGACY_FINALIZE_RUNTIME_RESIDUE"],
      ["requirement-summary.json", "{\"summary\":true}\n", 0o640, "LEGACY_RAW_SUMMARY_RESIDUE"],
      ["tests/.raw/upgrade.log", "corpus upgrade log\n", 0o640, "LEGACY_RAW_LOG_RESIDUE"],
      ["upgrade.log", "root upgrade log\n", 0o640, "LEGACY_UPGRADE_LOG_RESIDUE"],
      ["tmp/session.tmp", "temporary\n", 0o600, "LEGACY_RUNTIME_WORKSPACE_RESIDUE"],
      ["cache/compiled.cache", "cache bytes\n", 0o600, "LEGACY_RUNTIME_WORKSPACE_RESIDUE"],
      ["completed-transaction.json", "completed journal\n", 0o600, "LEGACY_TRANSACTION_JOURNAL_RESIDUE"],
    ];
    for (const [relativePath, bytes, mode] of residues) {
      writeFile(root, `${base}/${relativePath}`, bytes);
      fs.chmodSync(path.join(root, base, relativePath), mode);
    }
    // These similarly shaped user evidence files are not producer runtime
    // grammar and must retain their normal permanent migration authority.
    writeFile(root, `${base}/operator-notes.log`, "durable operator note\n");
    writeJson(root, `${base}/architecture-record.json`, { durable: true });

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    const catalog = JSON.parse(fs.readFileSync(path.join(version, "artifact-catalog.json"), "utf8"));
    for (const [relativePath, bytes, mode, reason] of residues) {
      const destination = `.runtime/migration/legacy-files/${relativePath}`;
      assert.equal(fs.readFileSync(path.join(version, destination), "utf8"), bytes, relativePath);
      assert.equal(fs.statSync(path.join(version, destination)).mode & 0o777, mode, relativePath);
      assert.equal(report.relocatedTransient.some((entry) => (
        entry.source === relativePath && entry.destination === destination && entry.reason === reason
      )), true, relativePath);
      const sourceFile = report.sourceFiles.find((entry) => entry.path === relativePath);
      assert.equal(sourceFile.hash, crypto.createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex"), relativePath);
      assert.equal(catalog.artifacts.some((entry) => entry.relativePath === destination), false, relativePath);
      assert.throws(() => FLOW_ARTIFACT_CONTRACTS.classify(destination), /not uniquely classified/, relativePath);
    }
    for (const livePath of [
      ".runtime/retry-recovery/transaction.json",
      ".runtime/locks/issue-log.lock",
      ".runtime/review-work-units/impl.json",
      ".runtime/finalize-cleanup/journal.json",
      ".runtime/test-execute/requirement-summary.json",
    ]) assert.equal(fs.existsSync(path.join(version, livePath)), false, livePath);
    assert.equal(catalog.artifacts.some((entry) => entry.relativePath.endsWith("operator-notes.log")), true);
    assert.equal(catalog.artifacts.some((entry) => entry.relativePath.endsWith("architecture-record.json")), true);

    const store = versionStore(root, id);
    const state = store.load();
    assertDormantHistoricalContinuationRefused(store, state, startActivity(state, { id: "runtime-residue-next" }));
    // A subsequent valid production write may use its own runtime lock.  It
    // must never revive the source-era lock as live runtime control input.
    assert.equal(fs.existsSync(path.join(version, ".runtime", "locks", "issue-log.lock")), false);
  });

  it("resolves explicit permanent artifact references through cataloged canonical destinations and skips missing, escaping, or ambiguous references", () => {
    const root = project();
    const valid = "515-permanent-reference-valid";
    const validBase = `specs/${valid}`;
    writeJson(root, `${validBase}/flow.json`, {
      spec: `${validBase}/spec.json`,
      steps: [{
        id: "direct-result",
        status: "done",
        result: {
          outcome: "passed",
          summary: "A real legacy artifact is referenced.",
          confirmedAt: "2026-01-03T00:00:00.000Z",
          artifactRefs: [{ kind: "artifact", id: "file-map.json" }],
        },
      }],
      tasks: [],
      state: {},
    });
    writeJson(root, `${validBase}/spec.json`, { title: "Permanent reference", tasks: [] });
    writeJson(root, `${validBase}/file-map.json`, { mappings: [{ requirement: "R-1", file: "src/example.js" }] });
    const validApplied = run(root);
    assert.equal(validApplied.status, 0, validApplied.stderr);
    const validState = versionStore(root, valid).load();
    assert.equal(validState.findNode("direct-result").result.artifactRefs[0].id, "steps/impl/file-map.json");
    const catalog = JSON.parse(fs.readFileSync(path.join(root, validBase, "001", "artifact-catalog.json"), "utf8"));
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === "steps/impl/file-map.json");
    const sourceHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(root, validBase, "001", "steps", "impl", "file-map.json")))
      .digest("hex");
    assert.equal(descriptor.hash, sourceHash);

    for (const scenario of [
      { label: "missing", reference: "artifacts/missing.json", code: "MISSING_PERMANENT_ARTIFACT_REFERENCE" },
      { label: "escaping", reference: "../outside.json", code: "INVALID_PERMANENT_ARTIFACT_REFERENCE" },
      { label: "ambiguous", reference: "reference.json", code: "AMBIGUOUS_PERMANENT_ARTIFACT_REFERENCE" },
    ]) {
      const blocked = `515-permanent-reference-${scenario.label}`;
      const base = `specs/${blocked}`;
      writeJson(root, `${base}/flow.json`, {
        spec: `${base}/spec.json`,
        steps: [{
          id: "referenced-step",
          status: "done",
          result: {
            outcome: "passed",
            summary: "Reference must be validated.",
            confirmedAt: "2026-01-03T00:00:00.000Z",
            artifactRefs: [{ kind: "artifact", id: scenario.reference }],
          },
        }],
        tasks: [],
        state: {},
      });
      writeJson(root, `${base}/spec.json`, { title: blocked, tasks: [] });
      if (scenario.label === "ambiguous") {
        writeJson(root, `${base}/one/reference.json`, { one: true });
        writeJson(root, `${base}/two/reference.json`, { two: true });
      }
      const neighbor = seedLegacy(root, `515-permanent-reference-${scenario.label}-neighbor`);
      const before = fs.readFileSync(path.join(root, base, "flow.json"), "utf8");
      const result = run(root);
      assert.equal(result.status, 1, scenario.label);
      assert.match(result.stderr, new RegExp(scenario.code), scenario.label);
      assert.equal(fs.existsSync(path.join(root, base, "001")), false, scenario.label);
      assert.equal(fs.readFileSync(path.join(root, base, "flow.json"), "utf8"), before, scenario.label);
      assert.equal(fs.existsSync(path.join(root, "specs", neighbor, "001", "flow.json")), true, scenario.label);
    }
  });

  it("records only detailed direct evidence as contiguous Activity notes and preserves aggregate-only results", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-direct-evidence-ledger");
    const base = `specs/${id}`;
    const flowPath = path.join(root, base, "flow.json");
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    flow.tasks = [{
      id: "T-1",
      status: "pending",
      steps: [{ id: "task-review", status: "pending" }],
    }];
    flow.stepAttempts = [
      {
        runId: "legacy-run",
        taskId: null,
        stepId: "impl-review",
        attempt: 3,
        outcome: { kind: "decision", terminal: true },
        recordedAt: "2026-01-03T00:00:03.000Z",
      },
      {
        runId: "legacy-run",
        taskId: "T-1",
        stepId: "task-review",
        attempt: 1,
        outcome: { kind: "decision", terminal: true },
        recordedAt: "2026-01-03T00:00:04.000Z",
      },
    ];
    flow.directCompletionReceipt = {
      sourceStep: "impl-gate",
      completedAt: "2026-01-03T00:00:01.000Z",
    };
    flow.directIntegrationReceipt = { integratedAt: "2026-01-03T00:00:02.000Z" };
    flow.reviewRecoveryBaselines = [{
      canonicalPhase: "test",
      createdAt: "2026-01-03T00:00:05.000Z",
    }];
    flow.retryRecovery = { entries: [{
      canonicalPhase: "impl",
      createdAt: "2026-01-03T00:00:06.000Z",
    }] };
    flow.canonicalReviewPassRecoveries = [{
      invalidatedDownstreamStep: "spec-gate",
      recoveredAt: "2026-01-03T00:00:07.000Z",
    }];
    writeJson(root, `${base}/flow.json`, flow);
    writeJson(root, `${base}/spec.json`, { title: "Detailed evidence fixture", tasks: [{ id: "T-1" }] });
    const digest = "b".repeat(64);
    writeJson(root, `${base}/review-evidence/${digest}.json`, {
      phase: "impl",
      taskId: "T-1",
      provenance: { capturedAt: "2026-01-03T00:00:08.000Z" },
    });
    const aggregateOnly = JSON.stringify({ attempts: 4 }, null, 2);
    writeFile(root, `${base}/test-review.json`, aggregateOnly);

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    const activities = fs.readFileSync(path.join(version, "activities.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.deepEqual(activities.map((activity) => activity.confirmationOrder), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(activities.map((activity) => activity.nodeId), [
      "impl-gate", "flow", "impl-review", "T-1-review", "test-review", "impl-review", "spec-gate", "T-1-review",
    ]);
    assert.ok(activities.every((activity) => activity.type === "note_recorded" && activity.attemptId === null && activity.sequence === null));
    const directEvidencePaths = activities.slice(0, -1).map((activity) => activity.references.artifacts[0].id);
    assert.deepEqual(directEvidencePaths.map((entry) => entry.replace(/[a-f0-9]{64}\.json$/, "")), [
      "steps/impl/gate/activity-evidence/",
      "steps/system/activity-evidence/",
      "steps/impl/review/activity-evidence/",
      "steps/impl/T-1/review/activity-evidence/",
      "steps/test-review/activity-evidence/",
      "steps/impl/review/activity-evidence/",
      "steps/spec-gate/activity-evidence/",
    ]);
    assert.equal(activities.at(-1).references.artifacts[0].id, `steps/impl/T-1/review/evidence/${digest}.json`);
    const catalog = JSON.parse(fs.readFileSync(path.join(version, "artifact-catalog.json"), "utf8"));
    for (const [activity, evidencePath] of activities.slice(0, -1).map((entry, index) => [entry, directEvidencePaths[index]])) {
      const document = JSON.parse(fs.readFileSync(path.join(version, evidencePath), "utf8"));
      assert.equal(document.activityId, activity.id);
      assert.deepEqual(document.owner, { nodeId: activity.nodeId, nodeKey: activity.nodeKey });
      const descriptor = catalog.artifacts.find((entry) => entry.relativePath === evidencePath);
      assert.equal(descriptor.logicalKey, "activity.evidence");
      assert.equal(descriptor.activityId, activity.id);
      assert.equal(descriptor.hash, crypto.createHash("sha256").update(fs.readFileSync(path.join(version, evidencePath))).digest("hex"));
    }
    assert.equal(fs.existsSync(path.join(version, "steps/test-review/result.json")), false);
    assert.equal(fs.readFileSync(path.join(version, "artifacts/migration/legacy-files/test-review.json"), "utf8"), aggregateOnly);

    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    assert.deepEqual(
      report.generated.find((entry) => entry.target === "activities.jsonl").inputs.map((input) => [input.source, input.pointer]),
      [
        ["flow.json", "/directCompletionReceipt/completedAt"],
        ["flow.json", "/directIntegrationReceipt/integratedAt"],
        ["flow.json", "/stepAttempts/0/recordedAt"],
        ["flow.json", "/stepAttempts/1/recordedAt"],
        ["flow.json", "/reviewRecoveryBaselines/0/createdAt"],
        ["flow.json", "/retryRecovery/entries/0/createdAt"],
        ["flow.json", "/canonicalReviewPassRecoveries/0/recoveredAt"],
        [`review-evidence/${digest}.json`, "/provenance/capturedAt"],
      ],
    );
    assert.deepEqual(
      report.generated.filter((entry) => entry.reason === "DIRECT_ACTIVITY_EVIDENCE").map((entry) => entry.target).sort(),
      [...directEvidencePaths].sort(),
    );
    assert.equal(report.preserved.find((entry) => entry.source === "test-review.json").reason, "INSUFFICIENT_EVENT_DETAIL");
    assert.ok(report.migration.identityBasis.every((entry) => entry.source.path === "flow.json"));
    assert.equal(report.migration.creationAuthority.status, "unavailable");
    assert.equal(JSON.parse(fs.readFileSync(path.join(version, "spec.json"), "utf8")).specId, id);

    const store = new CurrentFlowVersionStore({
      location: new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId: id, version: 1 }),
      definition: buildCurrentFlowDefinition(),
    });
    const state = store.load();
    assert.equal(state.confirmationOrder, 8);
    assert.equal(state.attempt, null);
    assertDormantHistoricalContinuationRefused(store, state, startActivity(state, { id: "migration-detailed-evidence-next" }));
  });

  it("preserves direct per-node attempt evidence without fabricating Attempts or admitting unsupported historical continuation", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-direct-attempt-sequences");
    const flow = legacyFlow(root, id);
    const branch = legacyStepLocation(flow.steps, "branch");
    const implReview = legacyStepLocation(flow.steps, "impl-review");
    assert.notEqual(branch, null);
    assert.notEqual(implReview, null);
    branch.node.runtimeLog = {
      runId: "legacy-branch-runtime",
      sequence: 1,
      attempt: 4,
      command: "sennel flow run branch",
      startedAt: "2026-01-03T00:00:01.000Z",
      endedAt: "2026-01-03T00:00:02.000Z",
      exitCode: 0,
    };
    // The runtime log and Step record independently identify the same third
    // attempt. They establish a maximum cursor, not two invented retries.
    implReview.node.runtimeLog = {
      runId: "legacy-impl-runtime",
      sequence: 1,
      attempt: 3,
      command: "sennel flow run impl-review",
      startedAt: "2026-01-03T00:00:03.000Z",
      endedAt: "2026-01-03T00:00:04.000Z",
      exitCode: 0,
    };
    flow.tasks = [{
      id: "T-1",
      status: "pending",
      steps: [{ id: "task-review", status: "pending" }],
    }];
    flow.stepAttempts = [
      {
        runId: "legacy-impl-step-record",
        taskId: null,
        stepId: "impl-review",
        attempt: 3,
        outcome: { kind: "decision", terminal: true },
        recordedAt: "2026-01-03T00:00:05.000Z",
      },
      {
        runId: "legacy-task-step-record",
        taskId: "T-1",
        stepId: "task-review",
        attempt: 1,
        outcome: { kind: "decision", terminal: true },
        recordedAt: "2026-01-03T00:00:06.000Z",
      },
    ];
    // An aggregate count has no concrete event identity and must not advance
    // a cursor. The neighboring canonical test-review node remains at zero.
    flow.reviewCount = { impl: 99, test: 42 };
    writeLegacyFlow(root, id, flow);
    writeJson(root, `specs/${id}/spec.json`, { title: "Direct attempt evidence", tasks: [{ id: "T-1" }] });

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const store = versionStore(root, id);
    const state = store.load();
    assert.equal(state.findNode("branch").attemptSequence, 4);
    assert.equal(state.findNode("impl-review").attemptSequence, 3);
    assert.equal(state.findNode("T-1-review").attemptSequence, 1);
    assert.equal(state.findNode("test-review").attemptSequence, 0);
    assert.equal(state.attempt, null);
    assert.equal(state.history.execution, "dormant");
    assert.ok(store.activities().every((entry) => (
      entry.type === "note_recorded"
      && entry.transition.operation === "record_note"
      && entry.attemptId === null
      && entry.sequence === null
    )));

    const report = JSON.parse(fs.readFileSync(path.join(root, "specs", id, "001", "flow-migration-report.json"), "utf8"));
    for (const pointer of [
      `${branch.pointer}/runtimeLog/attempt`,
      `${implReview.pointer}/runtimeLog/attempt`,
      "/stepAttempts/0/attempt",
      "/stepAttempts/1/attempt",
    ]) {
      assert.equal(report.converted.some((entry) => (
        entry.pointer === pointer && entry.reason === "DIRECT_ATTEMPT_SEQUENCE_EVIDENCE"
      )), true, pointer);
    }
    assert.equal(report.preserved.some((entry) => (
      entry.pointer === `${implReview.pointer}/runtimeLog/command`
      && entry.reason === "DIRECT_RUNTIME_LOG_AUXILIARY_FACT"
    )), true);
    assert.equal(report.preserved.some((entry) => entry.pointer === "/stepAttempts/0/runId"), true);
    assert.equal(report.preserved.some((entry) => entry.pointer === "/reviewCount/impl"), true);

    assertDormantHistoricalContinuationRefused(
      store,
      state,
      startActivity(state, { id: "migration-attempt-sequence-next", sequence: 5 }),
    );
  });

  it("consolidates review history and current result variants into one append-only artifact", () => {
    const root = project();
    const id = seedContinuableLegacy(root, "515-result-history-aggregation");
    const base = `specs/${id}`;
    writeJson(root, `${base}/review-history/test-attempt-001.json`, {
      phase: "test",
      attempt: 1,
      verdict: "REPAIR_REQUIRED",
      findings: [{ id: "legacy-history" }],
    });
    writeJson(root, `${base}/test-coverage.json`, { verdict: "PASS", source: "coverage" });
    writeJson(root, `${base}/test-review.json`, { verdict: "PASS", source: "current" });
    writeFile(root, `${base}/review-history/test-attempt-001.md`, "# Historical test evidence\n");
    writeFile(root, `${base}/spec.md`, "# Historical specification view\n");
    writeFile(root, `${base}/review.md`, "# Historical review view\n");

    const applied = run(root);
    assert.equal(applied.status, 0, applied.stderr);
    const version = path.join(root, base, "001");
    const result = JSON.parse(fs.readFileSync(path.join(version, "steps/test-review/result.json"), "utf8"));
    assert.deepEqual(result.attempts.map((entry) => entry.attempt), [1, 2, 3]);
    assert.equal(result.attempts[0].detail.verdict, "REPAIR_REQUIRED");
    assert.equal(result.attempts[1].legacySource, "test-coverage.json");
    assert.equal(result.attempts.at(-1).legacySource, "test-review.json");
    assert.equal(result.attempts.at(-1).detail.source, "current");
    assert.equal(
      fs.readFileSync(path.join(version, "artifacts/migration/legacy-files/review-history/test-attempt-001.md"), "utf8"),
      "# Historical test evidence\n",
    );
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/legacy-files/spec.md")), true);
    assert.equal(fs.existsSync(path.join(version, "artifacts/migration/legacy-files/review.md")), true);
    const report = JSON.parse(fs.readFileSync(path.join(version, "flow-migration-report.json"), "utf8"));
    const converted = report.converted.filter((entry) => entry.destination === "steps/test-review/result.json");
    assert.deepEqual(converted.map((entry) => entry.source).sort(), [
      "review-history/test-attempt-001.json", "test-coverage.json", "test-review.json",
    ]);
    assert.equal(report.preserved.some((entry) => entry.source === "review-history/test-attempt-001.md"), true);
  });

  it("checks candidate identities against every production-readable canonical Version in the repository", () => {
    const root = project();
    const legacyId = seedLegacy(root, "515-identity-candidate");
    const flowPath = `specs/${legacyId}/flow.json`;
    const legacy = JSON.parse(fs.readFileSync(path.join(root, flowPath), "utf8"));
    legacy.flowId = "shared-logical-flow";
    legacy.flowVersionId = "candidate-flow-version";
    legacy.runId = "candidate-run";
    writeJson(root, flowPath, legacy);
    createExistingVersion(root, "515-existing-version", {
      flowId: "shared-logical-flow",
      flowVersionId: "existing-flow-version",
      runId: "existing-run",
    });
    const preview = run(root, ["--dry-run"]);
    assert.equal(preview.status, 1);
    assert.match(preview.stderr, /FLOW_ID_CROSS_SPEC_COLLISION/);
    assert.equal(fs.existsSync(path.join(root, "specs", legacyId, "001")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", "515-existing-version", "001", "flow.json")), true);
  });

  it("fails closed for a legacy Flow missing its required spec authority while valid neighbors continue", () => {
    const root = project();
    const missing = seedLegacy(root, "515-missing-spec-authority");
    const neighbor = seedLegacy(root, "515-missing-spec-authority-neighbor");
    const flowPath = path.join(root, "specs", missing, "flow.json");
    const before = fs.readFileSync(flowPath, "utf8");
    fs.unlinkSync(path.join(root, "specs", missing, "spec.json"));

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISSING_SPEC_AUTHORITY/);
    assert.equal(fs.readFileSync(flowPath, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "specs", missing, "001")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", neighbor, "001", "flow.json")), true);
  });

  it("validates canonical Version directories and fails closed on mixed, unsafe, or mismatched already-applied roots", () => {
    const root = project();
    const versionDirectory = path.join(root, "version-directory-shapes");
    fs.mkdirSync(path.join(versionDirectory, "001"), { recursive: true });
    fs.mkdirSync(path.join(versionDirectory, "1000"), { recursive: true });
    assert.deepEqual(canonicalVersionDirectories(versionDirectory), ["001", "1000"]);
    for (const invalid of ["01", "0001", "000"]) {
      const invalidDirectory = path.join(root, `version-directory-${invalid}`);
      fs.mkdirSync(path.join(invalidDirectory, invalid), { recursive: true });
      assert.throws(() => canonicalVersionDirectories(invalidDirectory), /INVALID_VERSION_TARGET|normalized|invalid/);
    }

    const onlyVersion = "515-only-version";
    createExistingVersion(root, onlyVersion, {
      flowId: "only-version-flow",
      flowVersionId: "only-version-flow-version",
      runId: "only-version-run",
    });
    const mixed = "515-mixed-version-root";
    createExistingVersion(root, mixed, {
      flowId: "mixed-version-flow",
      flowVersionId: "mixed-version-flow-version",
      runId: "mixed-version-run",
    });
    writeFile(root, `specs/${mixed}/legacy-flow.txt`, "must remain beside no-op target\n");
    const mismatch = "515-version-spec-mismatch";
    createExistingVersion(root, mismatch, {
      flowId: "mismatch-flow",
      flowVersionId: "mismatch-flow-version",
      runId: "mismatch-run",
    });
    const mismatchSpecPath = path.join(root, "specs", mismatch, "001", "spec.json");
    const mismatchSpec = JSON.parse(fs.readFileSync(mismatchSpecPath, "utf8"));
    // Keep the fixture internally coherent while intentionally making its
    // authoritative Spec identity disagree with the Version directory.
    mismatchSpec.id = "515-another-spec";
    mismatchSpec.specId = "515-another-spec";
    fs.writeFileSync(mismatchSpecPath, `${JSON.stringify(mismatchSpec, null, 2)}\n`);
    refreshCatalogFile(root, mismatch, "spec.json");

    const invalidIdentityDirectory = path.join(root, "specs", "invalid spec identity");
    fs.mkdirSync(invalidIdentityDirectory, { recursive: true });
    fs.writeFileSync(path.join(invalidIdentityDirectory, "flow.json"), "{}\n");
    fs.writeFileSync(path.join(root, "specs", "515-special-entry"), "not a directory\n");
    fs.symlinkSync(path.join(root, "specs", onlyVersion), path.join(root, "specs", "515-spec-root-link"));
    const valid = seedLegacy(root, "515-root-entry-neighbor");

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MIXED_VERSION_ROOT/);
    assert.match(result.stderr, /VERSION_IDENTITY_MISMATCH/);
    assert.match(result.stderr, /INVALID_SPEC_IDENTITY/);
    assert.match(result.stderr, /UNSAFE_SPEC_ROOT_ENTRY/);
    assert.equal(fs.existsSync(path.join(root, "specs", valid, "001", "flow.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", onlyVersion, "001", "flow.json")), true);
    assert.equal(fs.readFileSync(path.join(root, "specs", mixed, "legacy-flow.txt"), "utf8"), "must remain beside no-op target\n");
    assert.equal(fs.existsSync(path.join(root, "specs", mismatch, "001", "flow.json")), true);
  });

  it("rejects each repository-wide identity collision without regenerating invalid values while valid neighbors continue", () => {
    const cases = [
      {
        label: "run-id",
        left: { runId: "shared-run-id", flowId: "run-left-flow", flowVersionId: "run-left-version" },
        right: { runId: "shared-run-id", flowId: "run-right-flow", flowVersionId: "run-right-version" },
        code: "RUN_ID_COLLISION",
      },
      {
        label: "flow-version-id",
        left: { runId: "version-left-run", flowId: "version-left-flow", flowVersionId: "shared-flow-version-id" },
        right: { runId: "version-right-run", flowId: "version-right-flow", flowVersionId: "shared-flow-version-id" },
        code: "FLOW_VERSION_ID_COLLISION",
      },
      {
        label: "flow-id-version",
        left: { runId: "tuple-left-run", flowId: "shared-logical-flow", flowVersionId: "tuple-left-version" },
        right: { runId: "tuple-right-run", flowId: "shared-logical-flow", flowVersionId: "tuple-right-version" },
        code: "FLOW_VERSION_TUPLE_COLLISION",
      },
    ];
    for (const scenario of cases) {
      const root = project();
      const left = seedLegacy(root, `515-${scenario.label}-left`);
      const right = seedLegacy(root, `515-${scenario.label}-right`);
      const neighbor = seedLegacy(root, `515-${scenario.label}-neighbor`);
      for (const [id, identity] of [[left, scenario.left], [right, scenario.right]]) {
        const flow = legacyFlow(root, id);
        Object.assign(flow, identity);
        writeLegacyFlow(root, id, flow);
      }
      const leftBefore = fs.readFileSync(path.join(root, "specs", left, "flow.json"), "utf8");
      const rightBefore = fs.readFileSync(path.join(root, "specs", right, "flow.json"), "utf8");
      const result = run(root);
      assert.equal(result.status, 1, scenario.label);
      assert.match(result.stderr, new RegExp(scenario.code), scenario.label);
      assert.equal(fs.existsSync(path.join(root, "specs", left, "001")), false, scenario.label);
      assert.equal(fs.existsSync(path.join(root, "specs", right, "001")), false, scenario.label);
      assert.equal(fs.readFileSync(path.join(root, "specs", left, "flow.json"), "utf8"), leftBefore, scenario.label);
      assert.equal(fs.readFileSync(path.join(root, "specs", right, "flow.json"), "utf8"), rightBefore, scenario.label);
      assert.equal(fs.existsSync(path.join(root, "specs", neighbor, "001", "flow.json")), true, scenario.label);
    }

    const root = project();
    const invalid = seedLegacy(root, "515-invalid-preserved-identity");
    const invalidFlow = legacyFlow(root, invalid);
    invalidFlow.flowId = "";
    writeLegacyFlow(root, invalid, invalidFlow);
    const mismatch = seedLegacy(root, "515-source-spec-identity-mismatch");
    const mismatchFlow = legacyFlow(root, mismatch);
    mismatchFlow.specId = "515-other-spec";
    writeLegacyFlow(root, mismatch, mismatchFlow);
    const neighbor = seedLegacy(root, "515-identity-invalid-neighbor");
    const invalidBefore = fs.readFileSync(path.join(root, "specs", invalid, "flow.json"), "utf8");
    const mismatchBefore = fs.readFileSync(path.join(root, "specs", mismatch, "flow.json"), "utf8");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INVALID_PRESERVED_IDENTITY/);
    assert.match(result.stderr, /SPEC_IDENTITY_MISMATCH/);
    assert.equal(fs.readFileSync(path.join(root, "specs", invalid, "flow.json"), "utf8"), invalidBefore);
    assert.equal(fs.readFileSync(path.join(root, "specs", mismatch, "flow.json"), "utf8"), mismatchBefore);
    assert.equal(fs.existsSync(path.join(root, "specs", neighbor, "001", "flow.json")), true);
  });

  it("recovers the crash window after the replacement source directory was created", () => {
    const root = project();
    const id = seedLegacy(root, "515-source-mkdir-crash");
    const { specRoot, candidate } = plannedCandidate(root, id);
    const crashing = new SpecsMigrationTransaction({
      root,
      specRoot,
      specId: id,
      targetRevision: 2,
      faultInjector({ phase }) {
        if (phase === "source-directory-created") throw new Error("simulated source mkdir crash");
      },
    });
    assert.throws(() => crashing.apply(candidate), /simulated source mkdir crash/);
    const source = path.join(root, "specs", id);
    const backup = fs.readdirSync(path.join(root, "specs")).find((name) => name.startsWith(`.${id}.sennel-migrate-specs-backup-`));
    assert.deepEqual(fs.readdirSync(source), []);
    assert.ok(backup);
    const journalDirectory = path.join(root, ".tmp", "sennel-migrate-specs");
    const journal = fs.readdirSync(journalDirectory).find((name) => name.endsWith(".json"));
    const beforeDryRun = fs.readFileSync(path.join(journalDirectory, journal), "utf8");
    const recovery = new SpecsMigrationTransaction({ root, specRoot, specId: id, targetRevision: 2 });
    assert.equal(recovery.recover({ dryRun: true }).requiresRecovery, true);
    assert.equal(fs.readFileSync(path.join(journalDirectory, journal), "utf8"), beforeDryRun);
    assert.equal(recovery.recover({ dryRun: false }).recovered, "placed-staging-after-source-mkdir");
    assert.equal(fs.existsSync(path.join(source, "001", "flow.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", backup)), false);
    assert.equal(fs.existsSync(path.join(journalDirectory, journal)), false);
    new CurrentFlowVersionStore({
      location: new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: "specs", specId: id, version: 1 }),
      definition: buildCurrentFlowDefinition(),
    }).load();
  });

  it("rechecks source bytes and modes immediately before the swap", () => {
    const root = project();
    const id = seedLegacy(root, "515-source-race");
    const { specRoot, candidate } = plannedCandidate(root, id);
    const transaction = new SpecsMigrationTransaction({
      root,
      specRoot,
      specId: id,
      faultInjector({ phase }) {
        if (phase === "journal-written") {
          fs.appendFileSync(path.join(root, "specs", id, "flow.json"), "\n");
        }
      },
    });
    assert.throws(() => transaction.apply(candidate), (error) => error.code === "SOURCE_CHANGED");
    assert.equal(fs.existsSync(path.join(root, "specs", id, "flow.json")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-specs")), false);
    assert.equal(fs.readdirSync(path.join(root, "specs", id)).some((name) => name.startsWith(".001.migrate-") && name.endsWith(".tmp")), false);
  });

  it("validates a materialized canonical Version before source rename and rolls back an owned invalid post-stage target", () => {
    const root = project();
    const id = seedLegacy(root, "515-pre-swap-validation");
    const sourcePath = path.join(root, "specs", id, "flow.json");
    const before = fs.readFileSync(sourcePath, "utf8");
    const beforeMode = fs.statSync(sourcePath).mode & 0o777;
    const { specRoot, candidate } = plannedCandidate(root, id);
    const invalidStage = new SpecsMigrationTransaction({
      root,
      specRoot,
      specId: id,
      faultInjector({ phase, location }) {
        if (phase === "stage-materialized") fs.writeFileSync(location.catalogFile, "{}\n");
      },
    });
    assert.throws(() => invalidStage.apply(candidate), /artifact catalog|schemaRevision|catalog/i);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-specs")), false);
    assert.equal(fs.readdirSync(path.join(root, "specs", id)).some((name) => name.startsWith(".001.migrate-")), false);

    const crashing = new SpecsMigrationTransaction({
      root,
      specRoot,
      specId: id,
      faultInjector({ phase }) {
        if (phase === "stage-placed") {
          fs.writeFileSync(path.join(root, "specs", id, "001", "artifact-catalog.json"), "{}\n");
          throw new Error("simulated invalid post-swap interruption");
        }
      },
    });
    assert.throws(() => crashing.apply(candidate), /simulated invalid post-swap interruption/);
    const backup = fs.readdirSync(path.join(root, "specs")).find((name) => name.startsWith(`.${id}.sennel-migrate-specs-backup-`));
    assert.ok(backup);
    const journalDirectory = path.join(root, ".tmp", "sennel-migrate-specs");
    assert.equal(fs.readdirSync(journalDirectory).some((name) => name.endsWith(".json")), true);
    const recovery = new SpecsMigrationTransaction({ root, specRoot, specId: id });
    assert.deepEqual(recovery.recover({ dryRun: false }), {
      specId: id,
      recovered: "rolled-back-invalid-target",
    });
    assert.equal(fs.readFileSync(sourcePath, "utf8"), before);
    assert.equal(fs.statSync(sourcePath).mode & 0o777, beforeMode);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", backup)), false);
    assert.equal(fs.existsSync(journalDirectory), false);
    const rerun = run(root);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001", "flow.json")), true);
  });

  it("rejects tampered Activity evidence through the production catalog validator before source swap", () => {
    const scenarios = [
      {
        label: "bytes no longer match the catalog descriptor",
        expected: /artifact content does not match (?:the )?catalog/i,
        tamper({ version, evidencePath }) {
          const document = JSON.parse(fs.readFileSync(path.join(version, evidencePath), "utf8"));
          document.note = "tampered bytes";
          fs.writeFileSync(path.join(version, evidencePath), `${JSON.stringify(document, null, 2)}\n`);
        },
      },
      {
        label: "evidence owner does not match its Activity after a catalog hash refresh",
        expected: /activity evidence document owner does not match its Activity/i,
        tamper({ version, evidencePath }) {
          const document = JSON.parse(fs.readFileSync(path.join(version, evidencePath), "utf8"));
          document.owner = { nodeId: "impl-gate", nodeKey: "impl-gate" };
          fs.writeFileSync(path.join(version, evidencePath), `${JSON.stringify(document, null, 2)}\n`);
          refreshCatalogDescriptorForBytes(version, evidencePath);
        },
      },
      {
        label: "unknown top-level evidence fields are rejected after a catalog hash refresh",
        expected: /activity evidence document must contain only schemaRevision, activityId, owner, observedAt, source, and note/i,
        tamper({ version, evidencePath }) {
          const document = JSON.parse(fs.readFileSync(path.join(version, evidencePath), "utf8"));
          document.unrecognized = "must not be ignored";
          fs.writeFileSync(path.join(version, evidencePath), `${JSON.stringify(document, null, 2)}\n`);
          refreshCatalogDescriptorForBytes(version, evidencePath);
        },
      },
      {
        label: "catalog Activity association does not match the evidence document",
        expected: /activity evidence document Activity id does not match its descriptor/i,
        tamper({ version, evidencePath }) {
          const activities = fs.readFileSync(path.join(version, "activities.jsonl"), "utf8")
            .trimEnd().split("\n").map((line) => JSON.parse(line));
          const document = JSON.parse(fs.readFileSync(path.join(version, evidencePath), "utf8"));
          const otherActivity = activities.find((entry) => entry.id !== document.activityId);
          assert.ok(otherActivity, "fixture must produce a second direct Activity evidence record");
          rewriteCatalogFile(version, (artifacts) => artifacts.map((entry) => (
            entry.relativePath === evidencePath ? { ...entry, activityId: otherActivity.id } : entry
          )));
        },
      },
    ];
    for (const scenario of scenarios) {
      const root = project();
      const id = seedContinuableLegacy(root, `515-evidence-tamper-${scenarios.indexOf(scenario) + 1}`);
      const flow = legacyFlow(root, id);
      flow.createdAt = "2026-01-01T00:00:00.000Z";
      flow.directIntegrationReceipt = { integratedAt: "2026-01-01T00:01:00.000Z" };
      writeLegacyFlow(root, id, flow);
      const sourcePath = path.join(root, "specs", id, "flow.json");
      const before = fs.readFileSync(sourcePath);
      const beforeMode = fs.statSync(sourcePath).mode & 0o777;
      const { specRoot, candidate } = plannedCandidate(root, id);
      const transaction = new SpecsMigrationTransaction({
        root,
        specRoot,
        specId: id,
        faultInjector({ phase, location }) {
          if (phase !== "stage-materialized") return;
          const evidenceDirectory = path.join(location.directory, "steps", "system", "activity-evidence");
          const evidenceNames = fs.readdirSync(evidenceDirectory);
          assert.equal(evidenceNames.length, 2, "fixture must create root creation and direct integration evidence files");
          const evidencePath = path.posix.join("steps", "system", "activity-evidence", evidenceNames[0]);
          scenario.tamper({ version: location.directory, evidencePath });
        },
      });
      assert.throws(() => transaction.apply(candidate), scenario.expected, scenario.label);
      assert.deepEqual(fs.readFileSync(sourcePath), before, scenario.label);
      assert.equal(fs.statSync(sourcePath).mode & 0o777, beforeMode, scenario.label);
      assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), false, scenario.label);
      assert.equal(fs.existsSync(path.join(root, ".tmp", "sennel-migrate-specs")), false, scenario.label);
      assert.equal(fs.readdirSync(path.join(root, "specs", id)).some((name) => name.startsWith(".001.migrate-") && name.endsWith(".tmp")), false, scenario.label);
    }
  });

  it("fails closed instead of rolling back when the placed target no longer has the journaled stage identity", () => {
    const root = project();
    const id = seedLegacy(root, "515-foreign-post-stage-target");
    const { specRoot, candidate } = plannedCandidate(root, id);
    const foreignTarget = path.join(root, "foreign-placed-version");
    const crashing = new SpecsMigrationTransaction({
      root,
      specRoot,
      specId: id,
      faultInjector({ phase }) {
        if (phase !== "stage-placed") return;
        const target = path.join(root, "specs", id, "001");
        fs.renameSync(target, foreignTarget);
        fs.mkdirSync(target);
        throw new Error("simulated foreign target replacement");
      },
    });
    assert.throws(() => crashing.apply(candidate), /simulated foreign target replacement/);
    const backup = fs.readdirSync(path.join(root, "specs")).find((name) => name.startsWith(`.${id}.sennel-migrate-specs-backup-`));
    const journalDirectory = path.join(root, ".tmp", "sennel-migrate-specs");
    const recovery = new SpecsMigrationTransaction({ root, specRoot, specId: id });
    assert.throws(() => recovery.recover({ dryRun: false }), /target identity does not match its journal/);
    assert.ok(backup);
    assert.equal(fs.existsSync(path.join(root, "specs", id, "001")), true);
    assert.equal(fs.existsSync(path.join(root, "specs", backup)), true);
    assert.equal(fs.existsSync(path.join(journalDirectory)), true);
    assert.equal(fs.existsSync(foreignTarget), true);
  });
});
