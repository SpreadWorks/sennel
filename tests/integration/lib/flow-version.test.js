import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactAuthority,
  ArtifactAuthoritySlot,
  ArtifactPublicationClaim,
  AuthoritativeSpecRecord,
  FlowArtifactCatalog,
  FlowArtifactActivityAssociation,
  FlowArtifactActivityIndex,
  FlowArtifactCatalogCommittedSnapshot,
  FlowArtifactCatalogSnapshotEvidence,
  FlowArtifactCatalogSnapshotReader,
  FlowArtifactCatalogStore,
  FlowArtifactDescriptor,
  FlowActivityId,
  FlowSpecRevision,
  FlowVersion,
  FlowVersionAuthorityScope,
  FlowVersionLocation,
  FlowVersionRelativeLocation,
  FlowTaskArtifactLocation,
  FlowVersionMigrationArtifact,
  FlowVersionMigrationClassifier,
  FlowVersionMigrationMappingRule,
  FlowVersionMigrationOutput,
  FlowVersionMigrationOutputSet,
  FlowVersionMigrationPlan,
  FlowVersionMigrationSourcePolicy,
} from "../../../src/lib/flow-version.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
const REVIEW_DIGEST_A = "a".repeat(64);
const REVIEW_DIGEST_B = "b".repeat(64);
const REVIEW_DIGEST_C = "c".repeat(64);
const PROCESS_LOCK_MODULE_PATH = fileURLToPath(new URL("../../../src/lib/process-lock.js", import.meta.url));
const DIRECTORY_AUTHORITY_MODULE_PATH = fileURLToPath(new URL("../../../src/lib/real-directory-authority.js", import.meta.url));
import {
  ActivityTransition,
  CurrentAttempt,
  CURRENT_FLOW_SCHEMA_REVISION,
  CurrentFlowStateAdoptionBoundary,
  CurrentFlowVersionMigrationOutputBuilder,
  CurrentFlowVersionSemanticValidator,
  FlowActivityJournal,
  FlowActivity,
} from "../../../src/flow/lib/current-flow-state.js";
import {
  artifactPublicationClaimForStep,
  assertCatalogPublicationAuthority,
} from "../../../src/flow/lib/flow-artifact-authority.js";
import { IssueLogStore } from "../../../src/flow/lib/issue-log-store.js";
import { ReviewDisposition, ReviewEvidence, ReviewProvenance } from "../../../src/flow/lib/review-convergence.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";

const roots = [];
function temporaryRoot() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "flow-version-"));
  roots.push(result);
  return result;
}
function canonicalLocation({ root = temporaryRoot(), specId = "508-flow-version", version = 1 } = {}) {
  return new FlowVersionLocation({
    repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(),
    specId,
    version,
  });
}
function identity(overrides = {}) {
  return {
    flowId: "series-a",
    flowVersionId: "series-a-v1",
    specId: "508-flow-version",
    runId: "run-123",
    request: "Keep this original request.",
    version: 1,
    ...overrides,
  };
}
function specRecord(specId = "508-flow-version") {
  return new AuthoritativeSpecRecord({ id: specId, title: "Version authority fixture", tasks: [] });
}
function representativeMigrationPolicy() {
  const exact = (source) => new FlowVersionMigrationMappingRule({
    match: "exact", source, targetPath: `artifacts/migration/${source}`, role: "artifact",
    operation: "copy", mediaType: source.endsWith(".json") ? "application/json" : "text/markdown",
    authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent",
  });
  const namespace = (source) => new FlowVersionMigrationMappingRule({
    match: "namespace", source, targetNamespace: `artifacts/migration/${source}`, role: "artifact",
    operation: "copy", mediaType: "application/json", authority: "canonical-flow-artifacts",
    cardinality: "collection", retention: "permanent",
  });
  return new FlowVersionMigrationSourcePolicy({
    rules: [
      "draft-coverage-repair.json", "draft-coverage-triage.json", "draft-review-coverage.json",
      "draft-review-questions.json", "draft.json", "issue.md",
    ].map(exact).concat(["plugin-artifacts", "review-history"].map(namespace)),
  });
}
function semanticValidator(definition = buildCurrentFlowDefinition()) {
  return new CurrentFlowVersionSemanticValidator({ definition });
}
function freshState(boundary, location, overrides = {}) {
  return boundary.createFresh({
    ...identity({ specId: location.specId.toString() }),
    ...overrides,
  });
}
function migrationOutputBuilder(definition = buildCurrentFlowDefinition()) {
  return new CurrentFlowVersionMigrationOutputBuilder({ semanticValidator: semanticValidator(definition) });
}
function singleton(kind, authority = "canonical-flow-artifacts") {
  return ArtifactAuthoritySlot.singleton({ kind, authority });
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function descriptor({ file, kind, authority = "canonical-flow-artifacts", memberId = null, content = file }) {
  const authoritySlot = memberId === null
    ? singleton(kind, authority)
    : ArtifactAuthoritySlot.collectionMember({ kind, authority, memberId, publicationStep: "impl-review" });
  return new FlowArtifactDescriptor({
    authoritySlot,
    relativePath: file,
    hash: hash(content),
    size: Buffer.byteLength(content),
    mediaType: "application/json",
    retention: "permanent",
  });
}
function saveCatalog(location, descriptors) {
  return new FlowArtifactCatalogStore({ location }).initialize(new FlowArtifactCatalog({ artifacts: descriptors }));
}
async function captureCommittedCatalogEvidence({ catalog, readArtifact }, value = null) {
  const ledger = catalog.resolve("activities.jsonl");
  const ledgerBytes = await readArtifact(ledger);
  return new FlowArtifactCatalogSnapshotEvidence({
    value,
    activityIndex: FlowArtifactActivityIndex.fromBytes(ledgerBytes),
    confirmedLedgerBytes: ledgerBytes,
  });
}
function spawnCatalogLockOwner(location, holdMs) {
  const runtimeLock = location.runtimeLock("runtime.lock.artifact-catalog");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import fs from "node:fs";`,
      `import { ProcessLock } from ${JSON.stringify(PROCESS_LOCK_MODULE_PATH)};`,
      `import { RealDirectoryAuthority } from ${JSON.stringify(DIRECTORY_AUTHORITY_MODULE_PATH)};`,
      `const directory = ${JSON.stringify(location.directory)};`,
      `const runtimeDirectory = ${JSON.stringify(runtimeLock.runtimeDirectory)};`,
      `const lockDirectory = ${JSON.stringify(runtimeLock.directory)};`,
      `const lockFileName = ${JSON.stringify(runtimeLock.fileName)};`,
      `fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o755 });`,
      "const directoryAuthority = new RealDirectoryAuthority(directory);",
      "const runtimeAuthority = new RealDirectoryAuthority(runtimeDirectory, { parentAuthority: directoryAuthority });",
      "const lockDirectoryAuthority = new RealDirectoryAuthority(lockDirectory, { parentAuthority: runtimeAuthority });",
      "const lock = new ProcessLock({",
      "  directoryAuthority: lockDirectoryAuthority,",
      "  fileName: lockFileName,",
      "  kind: \"artifact-catalog-publication\",",
      "  authority: { directory, runtimeDirectory, catalog: `${directory}/artifact-catalog.json` },",
      "});",
      "lock.acquire();",
      "process.stdout.write(\"locked\\n\");",
      `setTimeout(() => { lock.release(); }, ${holdMs});`,
    ].join("\n"),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return child;
}
function confirmationActivity(state, id) {
  const node = state.findNode(state.current.at(-1));
  return new FlowActivity({
    id,
    nodeId: node.id,
    nodeKey: node.key,
    attemptId: state.attempt.id,
    sequence: state.attempt.sequence,
    confirmationOrder: state.confirmationOrder + 1,
    type: "result_confirmed",
    transition: new ActivityTransition({
      operation: "confirm_attempt",
      nodeId: node.id,
      task: null,
      attempt: null,
      status: "done",
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
    }),
    result: {
      outcome: "passed",
      summary: `Completed ${node.id}.`,
      confirmedAt: "2026-08-08T00:00:01.000Z",
      artifactRefs: [],
    },
    timing: { startedAt: "2026-08-08T00:00:00.000Z", finishedAt: "2026-08-08T00:00:01.000Z", durationMs: 1000 },
    failure: null,
    provider: "test",
    model: "test",
    effort: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 },
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function appendCatalogActivity(location, { id, nodeId }) {
  const definition = buildCurrentFlowDefinition();
  const boundary = new CurrentFlowStateAdoptionBoundary({ definition });
  const flow = boundary.openVersionStore({ location });
  let state = flow.load();
  let sequence = 0;
  while (state.nextAction()?.nodeId !== nodeId) {
    const started = startActivity(state, { id: `fixture-${nodeId}-start-${sequence}` });
    state = flow.apply({ activity: started });
    state = flow.apply({ activity: confirmationActivity(state, `fixture-${nodeId}-confirm-${sequence}`) });
    sequence += 1;
  }
  return flow.apply({ activity: startActivity(state, { id }) });
}
function evidence(sequence) {
  return new ReviewEvidence({
    version: 1,
    phase: "impl",
    taskId: null,
    treeSha: String(sequence).padStart(40, "a"),
    provenance: new ReviewProvenance({
      provider: "test",
      invocationId: `review-${sequence}`,
      capturedAt: `2026-08-08T00:00:0${sequence}.000Z`,
    }),
    disposition: new ReviewDisposition({ value: "PASS" }),
  });
}
function startActivity(state, { id = "activity-1", attemptId = null } = {}) {
  const target = state.nextAction();
  const node = state.findNode(target.nodeId);
  const contract = state.definition.contractFor(target.nodeId, state.root);
  const attempt = new CurrentAttempt({
    id: attemptId ?? (id === "activity-1" ? "attempt-1" : `${id}-attempt`),
    nodeId: node.id,
    sequence: node.attemptSequence + 1,
    startedAt: "2026-08-08T00:00:00.000Z",
    consumption: { semantic: 0, tooling: 0 }, failure: null, blocker: null, incomplete: [],
    operationClaims: [{ operation: "execute", resources: [...contract.resourceContract.required] }],
  });
  return new FlowActivity({
    id, nodeId: node.id, nodeKey: node.key, attemptId: attempt.id, sequence: attempt.sequence,
    confirmationOrder: state.confirmationOrder + 1, type: "attempt_started",
    transition: new ActivityTransition({ operation: "start_attempt", nodeId: node.id, task: null, attempt, status: null, policy: null, outbox: null, approval: null, nonblocking: null }),
    result: null,
    timing: { startedAt: "2026-08-08T00:00:00.000Z", finishedAt: "2026-08-08T00:00:01.000Z", durationMs: 1000 },
    failure: null, provider: "test", model: "test", effort: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 },
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function addTaskActivity(state, { id = "add-task-activity", taskId = "T-mismatch", key = "mismatch" } = {}) {
  const nodeId = state.definition.dynamicTaskContainerId;
  const node = state.findNode(nodeId);
  return new FlowActivity({
    id,
    nodeId,
    nodeKey: node.key,
    attemptId: null,
    sequence: null,
    confirmationOrder: state.confirmationOrder + 1,
    type: "task_added",
    transition: new ActivityTransition({
      operation: "add_task",
      nodeId,
      task: { id: taskId, key },
      attempt: null,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
    }),
    result: null,
    timing: { startedAt: "2026-08-08T00:00:00.000Z", finishedAt: "2026-08-08T00:00:01.000Z", durationMs: 1000 },
    failure: null,
    provider: "test",
    model: "test",
    effort: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 },
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function updateAttemptActivity(state) {
  const node = state.findNode(state.current.at(-1));
  return new FlowActivity({
    id: "activity-2", nodeId: node.id, nodeKey: node.key, attemptId: state.attempt.id, sequence: state.attempt.sequence,
    confirmationOrder: state.confirmationOrder + 1, type: "attempt_updated",
    transition: new ActivityTransition({ operation: "update_attempt", nodeId: node.id, task: null, attempt: state.attempt, status: null, policy: null, outbox: null, approval: null, nonblocking: null }),
    result: null,
    timing: { startedAt: "2026-08-08T00:00:02.000Z", finishedAt: "2026-08-08T00:00:03.000Z", durationMs: 1000 },
    failure: null, provider: "test", model: "test", effort: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 },
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});
describe("Flow Version identity, schema, and consumer paths", () => {
  it("projects Spec schema content away from immutable Version identity", () => {
    const input = {
      id: "508-flow-version",
      nested: { preserved: "original" },
      tasks: [],
    };
    const payload = new AuthoritativeSpecRecord(input).schemaPayload();
    input.nested.preserved = "source mutation";
    const first = payload.toJSON();
    first.nested.preserved = "returned mutation";

    assert.deepEqual(payload.toJSON(), {
      nested: { preserved: "original" },
      tasks: [],
    });
    assert.equal(payload.canonicalText.includes('"id"'), false);
    assert.equal(payload.canonicalText.includes('"specId"'), false);
    assert.throws(
      () => new AuthoritativeSpecRecord({ id: "508-flow-version", specId: "other-version", tasks: [] }),
      /must agree/,
    );
  });

  it("persists the complete Version 1 identity only inside canonical flow.json", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    store.create(freshState(boundary, location), { specRecord: specRecord() });
    assert.deepEqual(store.flowIdentity().toJSON(), {
      flowId: "series-a",
      flowVersionId: "series-a-v1",
      runId: "run-123",
      specId: "508-flow-version",
      issue: null,
    });
    assert.equal(store.load().schemaRevision, CURRENT_FLOW_SCHEMA_REVISION);
    assert.equal(fs.existsSync(path.join(location.directory, "flow-version.json")), false);
  });

  it("resolves the Flow state through its logical artifact key", () => {
    assert.equal(canonicalLocation().relativeArtifact("flow.state"), "specs/508-flow-version/001/flow.json");
  });

  it("resolves every Version reader through an explicit artifact logical key", () => {
    const relative = new FlowVersionRelativeLocation({
      specRoot: "specs",
      specId: "508-flow-version",
      version: new FlowVersion(1),
    });
    assert.equal(relative.relativeDirectory, "specs/508-flow-version/001");
    assert.equal(relative.relativeArtifact("flow.state"), "specs/508-flow-version/001/flow.json");
    assert.equal(FlowVersionRelativeLocation.fromArtifactPath({
      relativeArtifactPath: relative.relativeArtifact("flow.state"),
      logicalKey: "flow.state",
    }).relativeDirectory, relative.relativeDirectory);
    assert.throws(() => FlowVersionRelativeLocation.fromArtifactPath({
      relativeArtifactPath: "specs/508-flow-version/flow.json",
      logicalKey: "flow.state",
    }), /canonical contract/);
    const location = canonicalLocation({ version: 1004 });
    assert.equal(new FlowVersion(1).pathSegment, "001");
    assert.equal(new FlowSpecRevision(1).pathSegment, "001");
    assert.equal(location.specSnapshotFile(1), location.artifact("spec.snapshot", { revision: "001" }));
    assert.equal(location.specReviewFile(new FlowSpecRevision(2)), location.artifact("spec.review", { revision: "002" }));
    assert.throws(() => new FlowSpecRevision(0), /positive safe integer/);
    assert.equal(location.relativeDirectory, "specs/508-flow-version/1004");
    assert.equal(location.artifact("task.review", { taskId: "T-1" }).endsWith(path.join("steps", "impl", "T-1", "review", "result.json")), true);
    assert.equal(location.reviewEvidencePath({ taskId: "T-1", digest: REVIEW_DIGEST_A }).endsWith(path.join("steps", "impl", "T-1", "review", "evidence", `${REVIEW_DIGEST_A}.json`)), true);
    assert.throws(() => location.reviewEvidencePath({ digest: REVIEW_DIGEST_A }), /review step/);
    assert.throws(() => location.artifact("review.evidence", { ownerPath: "impl/T-1/review", digest: REVIEW_DIGEST_A }), /typed registry/);
    assert.equal(location.reportFile.endsWith(path.join("artifacts", "report.json")), true);
    assert.throws(() => location.resolve("../flow.json"));
  });

  it("resolves a materialized Task topology through one typed Version location", () => {
    const location = canonicalLocation();
    const task = location.taskArtifactLocation("T-1");

    assert.ok(task instanceof FlowTaskArtifactLocation);
    assert.equal(task.taskId, "T-1");
    assert.equal(task.relativeDirectory, "steps/impl/T-1");
    assert.equal(task.directory, path.join(location.directory, "steps", "impl", "T-1"));
    assert.equal(task.implDirectory, path.join(location.directory, "steps", "impl", "T-1", "impl"));
    assert.equal(task.reviewDirectory, path.join(location.directory, "steps", "impl", "T-1", "review"));
    assert.equal(task.gateDirectory, path.join(location.directory, "steps", "impl", "T-1", "gate"));
    assert.equal(
      task.relativeArtifact("task.review"),
      "specs/508-flow-version/001/steps/impl/T-1/review/result.json",
    );
    assert.equal(task.reviewResultFile, location.artifact("task.review", { taskId: "T-1" }));
    assert.equal(task.gateSourceFile, location.artifact("task.gate.source", { taskId: "T-1" }));
    assert.equal(task.gateResultFile, location.artifact("task.gate", { taskId: "T-1" }));
    assert.throws(() => task.artifact("impl.review"), /does not own logical key/);
    assert.throws(() => task.relativeDirectoryFor("report"), /segment is invalid/);
  });

  it("rejects unsafe Task identities before resolving Version paths", () => {
    const location = canonicalLocation();
    for (const taskId of ["../escape", "T/1", "T 1", ""]) {
      assert.throws(() => location.taskArtifactLocation(taskId), /taskId must be/);
    }
  });

  it("requires explicit canonical authority for persistent stores", () => {
    const execution = new FlowVersionLocation({
      repositoryRoot: temporaryRoot(), authorityScope: FlowVersionAuthorityScope.execution(),
      specId: "508-flow-version", version: 1,
    });
    assert.throws(() => new FlowArtifactCatalogStore({ location: execution }), /canonical Version authority/);
    assert.throws(() => new FlowVersionLocation({ repositoryRoot: temporaryRoot(), specId: "x", version: 1 }), /authority scope/);
  });
});

describe("Flow Version filesystem authority", () => {
  it("rejects a Version-root symlink before following it", () => {
    const root = temporaryRoot();
    const location = canonicalLocation({ root });
    const outside = temporaryRoot();
    fs.mkdirSync(path.dirname(location.directory), { recursive: true });
    fs.symlinkSync(outside, location.directory);
    assert.throws(() => new FlowArtifactCatalogStore({ location }).load(), /symbolic link/);
  });

  it("rejects a symlinked specId ancestor that escapes the repository", () => {
    const root = temporaryRoot();
    const location = canonicalLocation({ root });
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    fs.symlinkSync(temporaryRoot(), path.join(root, "specs", "508-flow-version"));
    assert.throws(() => location.assertAuthority(), /symbolic link/);
  });
});

describe("Flow artifact catalog authority slots", () => {
  it("allows distinct collection members but rejects the same logical member", () => {
    const reviewDescriptor = (digest) => {
      const artifact = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest });
      return new FlowArtifactDescriptor({
        logicalKey: artifact.logicalKey, authoritySlot: artifact.authoritySlotFor("impl-review"),
        relativePath: artifact.relativePath, hash: hash(digest), size: digest.length,
        mediaType: "application/json", retention: "permanent",
      });
    };
    const first = reviewDescriptor(REVIEW_DIGEST_A);
    const second = reviewDescriptor(REVIEW_DIGEST_B);
    assert.equal(new FlowArtifactCatalog({ artifacts: [first, second] }).artifacts.length, 2);
    assert.throws(() => new FlowArtifactCatalog({ artifacts: [
      first,
      reviewDescriptor(REVIEW_DIGEST_A),
    ] }), /duplicate artifact path/);
    assert.throws(() => new ArtifactAuthoritySlot({
      kind: "review-evidence", authority: "canonical-flow-artifacts", cardinality: "collection", publicationStep: "impl-review",
    }), /requires a memberId/);
    const typed = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest: REVIEW_DIGEST_A });
    assert.throws(() => new FlowArtifactDescriptor({
      logicalKey: typed.logicalKey,
      authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "review-evidence", authority: "canonical-flow-artifacts", memberId: typed.memberId, publicationStep: "spec-review",
      }),
      relativePath: typed.relativePath, hash: hash("a"), size: 1, mediaType: "application/json", retention: "permanent",
    }), /derived from its typed owner and digest/);
    assert.throws(() => ArtifactAuthoritySlot.singleton({ kind: "result", authority: "arbitrary" }), /invalid artifact authority/);
  });

  it("binds publication claims to the executable ownership matrix", () => {
    assert.equal(assertCatalogPublicationAuthority("impl-review", new ArtifactAuthority("canonical-flow-artifacts")).stepId, "impl-review");
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("a.json"), "a");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("result"), relativePath: "artifacts/migration/a.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);
    const store = new FlowArtifactCatalogStore({ location });
    assert.throws(() => store.publish({
      relativePath: "artifacts/migration/a.json", authoritySlot: singleton("result"),
      publicationClaim: artifactPublicationClaimForStep("branch"),
      mediaType: "application/json", retention: "permanent", write: () => {},
    }), /artifact publication claim step mismatch: branch cannot publish system/);
    assert.throws(() => store.publish({
      relativePath: "artifacts/migration/a.json",
      authoritySlot: ArtifactAuthoritySlot.singleton({
        kind: "result", authority: "canonical-flow-artifacts", publicationStep: "impl-review",
      }),
      publicationClaim: artifactPublicationClaimForStep("spec-review"),
      mediaType: "application/json", retention: "permanent", write: () => {},
    }), /claim step mismatch/);
    assert.throws(() => artifactPublicationClaimForStep("not-a-step"), /unknown/);
    assert.throws(() => new ArtifactPublicationClaim({
      producer: "system", stepId: "version-storage", authority: "system",
    }), /only be issued/);
    assert.throws(() => new ArtifactPublicationClaim({
      producer: "worker", stepId: "impl-review", authority: "canonical-flow-artifacts",
    }), /only be issued/);
    assert.throws(() => store.publishSystem({
      relativePath: "steps/impl/review/evidence/bypass.json",
      authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "review-evidence", authority: "canonical-flow-artifacts",
        memberId: "bypass", publicationStep: "system",
      }),
      mediaType: "application/json", retention: "permanent", write: () => {},
    }), /system publication is not authorized/);
  });

  it("validates Activity ledger syntax, uniqueness, and catalog associations", () => {
    const setup = (ledgerText, associatedId = null) => {
      const location = canonicalLocation();
      fs.mkdirSync(path.dirname(location.artifactPath("result.json")), { recursive: true });
      fs.writeFileSync(location.activitiesFile, ledgerText);
      fs.writeFileSync(location.artifactPath("result.json"), "result");
      const descriptors = [
        FlowArtifactDescriptor.fromFile({
          location, authoritySlot: singleton("activity-ledger"), relativePath: "activities.jsonl",
          mediaType: "application/x-ndjson", retention: "permanent",
        }),
        FlowArtifactDescriptor.fromFile({
          location, authoritySlot: singleton("result"), relativePath: "artifacts/migration/result.json",
          mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
          activityId: associatedId === null ? null : new FlowActivityId(associatedId),
        }),
      ];
      return { location, catalog: new FlowArtifactCatalog({ artifacts: descriptors }) };
    };
    assert.throws(() => {
      const value = setup("not-json\n");
      new FlowArtifactCatalogStore({ location: value.location }).initialize(value.catalog);
    }, /malformed JSON/);
    assert.throws(() => {
      const value = setup('{"id":"activity-1","confirmationOrder":1}\n{"id":"activity-1","confirmationOrder":2}\n');
      new FlowArtifactCatalogStore({ location: value.location }).initialize(value.catalog);
    }, /duplicate Activity id/);
    assert.throws(() => {
      const value = setup('{"id":"activity-1","confirmationOrder":1}\n', "activity-missing");
      new FlowArtifactCatalogStore({ location: value.location }).initialize(value.catalog);
    }, /references a missing Activity/);
    const valid = setup('{"id":"activity-1","confirmationOrder":1}\n', "activity-1");
    assert.doesNotThrow(() => new FlowArtifactCatalogStore({ location: valid.location }).initialize(valid.catalog));

    const taskReview = FLOW_ARTIFACT_CONTRACTS.resolve("task.review", { taskId: "T-1" });
    const taskDescriptor = new FlowArtifactDescriptor({
      logicalKey: taskReview.logicalKey,
      authoritySlot: taskReview.authoritySlotFor("task-review"),
      relativePath: taskReview.relativePath,
      hash: "a".repeat(64),
      size: 1,
      mediaType: "application/json",
      retention: "permanent",
      activityId: "activity-task-review",
    });
    assert.doesNotThrow(() => new FlowArtifactActivityAssociation({
      id: "activity-task-review", nodeId: "T-1-review", nodeKey: "impl.T-1.review", confirmationOrder: 1,
    }).assertRelatedArtifact(taskDescriptor));
    assert.throws(() => new FlowArtifactActivityAssociation({
      id: "activity-task-review", nodeId: "T-2-review", nodeKey: "impl.T-2.review", confirmationOrder: 1,
    }).assertRelatedArtifact(taskDescriptor), /task artifact owner/);

    // A Task Attempt owns a task-local Step, but its journal transition also
    // updates the one flow.json authority.  That association must remain
    // valid without pretending flow.json is a task-owned result artifact.
    const flowState = FLOW_ARTIFACT_CONTRACTS.resolve("flow.state");
    const flowStateDescriptor = new FlowArtifactDescriptor({
      logicalKey: flowState.logicalKey,
      authoritySlot: flowState.authoritySlotFor("task-impl"),
      relativePath: flowState.relativePath,
      hash: "b".repeat(64),
      size: 1,
      mediaType: "application/json",
      retention: "permanent",
      activityId: "activity-task-impl",
    });
    assert.doesNotThrow(() => new FlowArtifactActivityAssociation({
      id: "activity-task-impl", nodeId: "T-1-impl", nodeKey: "task.task-impl", confirmationOrder: 1,
    }).assertRelatedArtifact(flowStateDescriptor));

    // Task retry recovery remains route-scoped evidence outside the Task
    // deliverable directory, but the route's Task suffix must be the exact
    // Task Activity that publishes it.
    for (const logicalKey of ["retry.recovery.baseline", "retry.recovery.receipt"]) {
      const recovery = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, {
        routeId: "review-impl-T-1",
        attemptId: "attempt-task-review",
      });
      const recoveryDescriptor = new FlowArtifactDescriptor({
        logicalKey: recovery.logicalKey,
        authoritySlot: recovery.authoritySlotFor("task-review"),
        relativePath: recovery.relativePath,
        hash: "d".repeat(64),
        size: 1,
        mediaType: "application/json",
        retention: "permanent",
        activityId: `activity-${logicalKey}`,
      });
      assert.doesNotThrow(() => new FlowArtifactActivityAssociation({
        id: `activity-${logicalKey}`, nodeId: "T-1-review", nodeKey: "impl.T-1.review", confirmationOrder: 1,
      }).assertRelatedArtifact(recoveryDescriptor));
      assert.throws(() => new FlowArtifactActivityAssociation({
        id: `activity-${logicalKey}`, nodeId: "T-2-review", nodeKey: "impl.T-2.review", confirmationOrder: 1,
      }).assertRelatedArtifact(recoveryDescriptor), /route does not match its related Activity Task/);
    }

    const upgrade = FLOW_ARTIFACT_CONTRACTS.resolve("upgrade.result");
    const upgradeDescriptor = new FlowArtifactDescriptor({
      logicalKey: upgrade.logicalKey,
      authoritySlot: upgrade.authoritySlotFor("system"),
      relativePath: upgrade.relativePath,
      hash: "c".repeat(64),
      size: 1,
      mediaType: "application/json",
      retention: "permanent",
      activityId: "activity-upgrade",
    });
    assert.doesNotThrow(() => new FlowArtifactActivityAssociation({
      id: "activity-upgrade", nodeId: "implement", nodeKey: "flow.implement", confirmationOrder: 1,
      operation: "confirm_attempt",
    }).assertRelatedArtifact(upgradeDescriptor));
    assert.doesNotThrow(() => new FlowArtifactActivityAssociation({
      id: "activity-upgrade", nodeId: "flow", nodeKey: "flow", confirmationOrder: 1,
      operation: "publish_upgrade_result",
    }).assertRelatedArtifact(upgradeDescriptor));
    assert.throws(() => new FlowArtifactActivityAssociation({
      id: "activity-upgrade", nodeId: "impl-gate", nodeKey: "flow.impl-gate", confirmationOrder: 1,
      operation: "confirm_attempt",
    }).assertRelatedArtifact(upgradeDescriptor), /source completion or publish_upgrade_result/);
  });

  it("does not create a missing Version root on authoritative reads", () => {
    const location = canonicalLocation();
    const store = new FlowArtifactCatalogStore({ location });
    assert.equal(fs.existsSync(location.directory), false);
    assert.throws(() => store.load(), /does not exist/);
    assert.equal(fs.existsSync(location.directory), false);
    assert.throws(() => store.require(), /does not exist/);
    assert.equal(fs.existsSync(location.directory), false);
  });

  it("rejects uncontracted artifacts outside migration materialization", () => {
    const location = canonicalLocation();
    const file = location.resolve("artifacts/uncontracted.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "uncontracted");
    assert.throws(() => FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("uncontracted"), relativePath: "artifacts/uncontracted.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    }), /outside catalog-managed storage/);
    const migrationOnly = location.resolve("artifacts/migration/uncontracted.json");
    fs.mkdirSync(path.dirname(migrationOnly), { recursive: true });
    fs.writeFileSync(migrationOnly, "migration-only");
    assert.throws(() => FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("uncontracted"), relativePath: "artifacts/migration/uncontracted.json",
      mediaType: "application/json", retention: "permanent",
    }), /uniquely classified/);
  });

  it("preserves corrupt lock errors instead of reporting BUSY", () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("a.json"), "a");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("a"), relativePath: "artifacts/migration/a.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);
    fs.mkdirSync(location.resolve(".runtime/locks"), { recursive: true });
    fs.writeFileSync(location.resolve(".runtime/locks/artifact-catalog.lock"), "corrupt");
    assert.throws(() => new FlowArtifactCatalogStore({ location }).load(), (error) => (
      error.code === "PROCESS_LOCK_CORRUPT" && error.code !== "FLOW_ARTIFACT_CATALOG_BUSY"
    ));
  });

  it("rejects same-process catalog lock reentry without waiting", () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("a.json"), "a");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("a"), relativePath: "artifacts/migration/a.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);
    const first = new FlowArtifactCatalogStore({ location });
    const second = new FlowArtifactCatalogStore({ location });
    first.publishSystem({
      relativePath: "artifacts/migration/a.json", authoritySlot: singleton("a"),
      mediaType: "application/json", retention: "permanent",
      write: () => {
        assert.throws(() => second.load(), (error) => (
          error.code === "PROCESS_LOCK_REENTRANT"
            && error.lockStatus === "reentrant"
            && error.retryable === false
        ));
        fs.writeFileSync(location.artifactPath("a.json"), "updated");
      },
    });
    assert.equal(fs.readFileSync(location.artifactPath("a.json"), "utf8"), "updated");
  });

  it("waits for a live external catalog authority before reading", async () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("a.json"), "a");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("a"), relativePath: "artifacts/migration/a.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);

    const child = spawnCatalogLockOwner(location, 500);
    const childExit = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const startedAt = Date.now();
      const catalog = new FlowArtifactCatalogStore({ location }).load();
      assert.equal(catalog.resolve("artifacts/migration/a.json").relativePath, "artifacts/migration/a.json");
      assert.ok(Date.now() - startedAt >= 250, "catalog read should wait for the external lock");
      const [status] = await childExit;
      assert.equal(status, 0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("restores the complete managed tree after undeclared mutation, deletion, and creation", () => {
    for (const attack of ["mutate", "delete", "create", "hardlink"]) {
      const location = canonicalLocation();
      fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
      fs.writeFileSync(location.artifactPath("a.json"), "a-before");
      fs.writeFileSync(location.artifactPath("b.json"), "b-before");
      const descriptors = [
        FlowArtifactDescriptor.fromFile({ location, authoritySlot: singleton("a"), relativePath: "artifacts/migration/a.json", mediaType: "application/json", retention: "permanent", migrationMaterialization: true }),
        FlowArtifactDescriptor.fromFile({ location, authoritySlot: singleton("b"), relativePath: "artifacts/migration/b.json", mediaType: "application/json", retention: "permanent", migrationMaterialization: true }),
      ];
      saveCatalog(location, descriptors);
      const catalogBefore = fs.readFileSync(location.catalogFile);
      const store = new FlowArtifactCatalogStore({ location });
      assert.throws(() => store.publishSystem({
        relativePath: "artifacts/migration/a.json", authoritySlot: singleton("a"),
        mediaType: "application/json", retention: "permanent",
        write: () => {
          fs.writeFileSync(location.artifactPath("a.json"), "a-after");
          if (attack === "mutate") fs.writeFileSync(location.artifactPath("b.json"), "b-after");
          if (attack === "delete") fs.unlinkSync(location.artifactPath("b.json"));
          if (attack === "create") {
            fs.mkdirSync(path.dirname(location.artifactPath("rogue/deep.json")), { recursive: true });
            fs.writeFileSync(location.artifactPath("rogue/deep.json"), "rogue");
          }
          if (attack === "hardlink") fs.linkSync(location.artifactPath("b.json"), location.artifactPath("rogue.json"));
        },
      }), /undeclared Version artifact|hard linked/);
      assert.equal(fs.readFileSync(location.artifactPath("a.json"), "utf8"), "a-before");
      assert.equal(fs.readFileSync(location.artifactPath("b.json"), "utf8"), "b-before");
      assert.equal(fs.existsSync(location.artifactPath("rogue")), false);
      assert.equal(fs.existsSync(location.artifactPath("rogue.json")), false);
      assert.deepEqual(fs.readFileSync(location.catalogFile), catalogBefore);
    }
  });

  it("removes never-created nested parents when a declared write fails", () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("base.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("base.json"), "base");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("base"), relativePath: "artifacts/migration/base.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);
    const store = new FlowArtifactCatalogStore({ location });
    assert.throws(() => store.publishSystem({
      relativePath: "artifacts/migration/new/deep/result.json", authoritySlot: singleton("new"),
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
      write: () => {
        fs.mkdirSync(path.dirname(location.artifactPath("new/deep/result.json")), { recursive: true });
        fs.writeFileSync(location.artifactPath("new/deep/result.json"), "new");
        throw new Error("injected write failure");
      },
    }), /injected write failure/);
    assert.equal(fs.existsSync(location.artifactPath("new")), false);
  });

  it("rejects hard links and arbitrary persistent hidden subtrees while excluding runtime work units", () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("source.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("source.json"), "source");
    fs.linkSync(location.artifactPath("source.json"), location.artifactPath("linked.json"));
    assert.throws(() => FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("source"), relativePath: "artifacts/migration/source.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    }), /hard linked/);
    fs.unlinkSync(location.artifactPath("linked.json"));
    const source = FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("source"), relativePath: "artifacts/migration/source.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    });
    fs.mkdirSync(location.resolve(".sennel"));
    fs.writeFileSync(location.resolve(".sennel/arbitrary.json"), "rogue");
    assert.throws(() => saveCatalog(location, [source]), /unclassified artifact/);
    fs.rmSync(location.resolve(".sennel"), { recursive: true });
    fs.mkdirSync(location.resolve(".runtime/unknown"), { recursive: true });
    fs.writeFileSync(location.resolve(".runtime/unknown/arbitrary.json"), "rogue");
    // `.runtime/` is the only non-authoritative Version subtree. Its
    // work-unit bytes must not become catalog evidence or make a valid Flow
    // unreadable merely because a worker left transient state behind.
    assert.doesNotThrow(() => saveCatalog(location, [source]));
  });

  it("only unpublishes an existing catalog-managed member", () => {
    const location = canonicalLocation();
    fs.mkdirSync(path.dirname(location.artifactPath("a.json")), { recursive: true });
    fs.writeFileSync(location.artifactPath("a.json"), "a");
    saveCatalog(location, [FlowArtifactDescriptor.fromFile({
      location, authoritySlot: singleton("a"), relativePath: "artifacts/migration/a.json",
      mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
    })]);
    const store = new FlowArtifactCatalogStore({ location });
    for (const invalid of [".runtime/x.json", "artifact-catalog.json", ".artifact-catalog.lock", "artifacts/missing.json"]) {
      assert.throws(() => store.unpublishSystem({
        relativePath: invalid, write: () => {},
      }), /managed artifact path|does not exist|not cataloged/);
    }
    store.unpublishSystem({
      relativePath: "artifacts/migration/a.json",
      write: () => fs.unlinkSync(location.artifactPath("a.json")),
    });
    assert.equal(store.load().artifacts.length, 0);
  });
});

describe("Flow Version migration classification", () => {
  function coherentFixture(source, target, OutputBuilder = CurrentFlowVersionMigrationOutputBuilder) {
    const definition = buildCurrentFlowDefinition();
    const validator = semanticValidator(definition);
    const plan = new FlowVersionMigrationClassifier({
      target, semanticValidator: validator, outputBuilder: new OutputBuilder({ semanticValidator: validator }),
    }).inspect(source).plan();
    return plan.outputFixture({
      state: freshState(new CurrentFlowStateAdoptionBoundary({ definition }), target), spec: specRecord(),
    });
  }

  it("keeps source generation and aggregate output contracts unambiguous", () => {
    const mapping = (operation, outputKey = null) => new FlowVersionMigrationMappingRule({
      match: "exact", source: "input.json", targetPath: "artifacts/migration/output.json",
      role: "artifact", operation, outputKey, mediaType: "application/json",
      authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent",
    });
    assert.throws(() => mapping("generate", "generated-output"), /cannot generate/);
    assert.throws(() => mapping("copy", "copy-output"), /only valid for transform/);
    assert.throws(() => new FlowVersionMigrationArtifact({
      role: "artifact", sourcePath: "input.json", targetPath: "artifacts/migration/output.json",
      operation: "copy", outputKey: "copy-output", sourceHash: "a".repeat(64), size: 1,
      mediaType: "application/json", authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "artifact", authority: "canonical-flow-artifacts", memberId: "copy-member", publicationStep: "system",
      }), retention: "permanent",
    }), /only valid for transform/);

    const output = (retention) => new FlowVersionMigrationOutput({
      outputKey: "aggregate", targetPath: "artifacts/output.json", operation: "transform",
      bytes: Buffer.from("same"), mediaType: "application/json",
      authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "artifact", authority: "canonical-flow-artifacts", memberId: "aggregate-member", publicationStep: "system",
      }), retention,
    });
    assert.throws(() => new FlowVersionMigrationOutputSet([
      output("permanent"), output("ephemeral"),
    ]), /output key conflict/);

    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    for (const file of ["flow.json", "spec.json", "one.json", "two.json"]) fs.writeFileSync(path.join(source, file), "{}");
    const transform = (sourcePath, mediaType) => new FlowVersionMigrationMappingRule({
      match: "exact", source: sourcePath, targetPath: "artifacts/migration/aggregate.json",
      role: "artifact", operation: "transform", outputKey: "aggregate-output", mediaType,
      authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent",
    });
    const inspection = new FlowVersionMigrationClassifier({
      target: canonicalLocation(), sourcePolicy: new FlowVersionMigrationSourcePolicy({
        rules: [transform("one.json", "application/json"), transform("two.json", "text/plain")],
      }), semanticValidator: semanticValidator(), outputBuilder: migrationOutputBuilder(),
    }).inspect(source);
    assert.equal(inspection.classification.blockers.some((blocker) => blocker.code === "PORTABLE_TARGET_COLLISION"), true);
    assert.equal(inspection.classification.blockers.some((blocker) => blocker.code === "DUPLICATE_AUTHORITY_SLOT"), true);
    assert.throws(() => inspection.plan(), /cannot plan/);
  });

  it("excludes owned runtime files while active nested transaction markers block", () => {
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(path.join(source, ".runtime", "resume"), { recursive: true });
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    fs.writeFileSync(path.join(source, ".runtime", "resume", "state.json"), "runtime");
    const target = canonicalLocation();
    const fixture = coherentFixture(source, target);
    const runtime = fixture.plan.artifacts.find((artifact) => artifact.sourcePath.endsWith("state.json"));
    assert.equal(runtime.operation.toJSON(), "exclude-runtime");
    assert.equal(runtime.targetPath, null);
    const materialized = fixture.materialize();
    assert.equal(fs.existsSync(materialized.location.resolve(".runtime/resume/state.json")), false);
    assert.equal(materialized.catalog.artifacts.some((artifact) => artifact.relativePath.includes("state.json")), false);

    fs.mkdirSync(path.join(source, "unsupported-layout", "review"), { recursive: true });
    fs.writeFileSync(path.join(source, "unsupported-layout", "review", "result.json"), "{}");
    const blocked = new FlowVersionMigrationClassifier({ target: canonicalLocation() }).inspect(source);
    assert.equal(blocked.classification.blockers.some((blocker) => blocker.code === "UNKNOWN_VISIBLE_ARTIFACT" && blocker.path === "unsupported-layout/review/result.json"), true);
  });

  it("binds materialization to the complete inventory and preserves a foreign target race", () => {
    for (const drift of ["file", "symlink", "lock"]) {
      const source = path.join(temporaryRoot(), "legacy");
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "flow.json"), "{}");
      fs.writeFileSync(path.join(source, "spec.json"), "{}");
      const target = canonicalLocation();
      const fixture = coherentFixture(source, target);
      if (drift === "file") fs.writeFileSync(path.join(source, "unknown.json"), "{}");
      if (drift === "symlink") fs.symlinkSync(path.join(source, "flow.json"), path.join(source, "added.json"));
      if (drift === "lock") fs.writeFileSync(path.join(source, "nested.transaction.lock"), "active");
      assert.throws(() => fixture.materialize(), /source inventory changed/);
      assert.equal(fs.existsSync(target.directory), false);
    }

    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    const target = canonicalLocation();
    class RacingBuilder extends CurrentFlowVersionMigrationOutputBuilder {
      build(options) {
        const outputs = super.build(options);
        fs.mkdirSync(target.directory, { recursive: true });
        fs.writeFileSync(path.join(target.directory, "foreign-sentinel"), "foreign");
        return outputs;
      }
    }
    assert.throws(() => coherentFixture(source, target, RacingBuilder).materialize(), /target must be absent/);
    assert.equal(fs.readFileSync(path.join(target.directory, "foreign-sentinel"), "utf8"), "foreign");
  });

  it("aggregates singleton authority and portable Unicode target collisions", () => {
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    fs.writeFileSync(path.join(source, "one.json"), "1");
    fs.writeFileSync(path.join(source, "two.json"), "2");
    const rule = (sourcePath, targetPath, cardinality = "collection") => new FlowVersionMigrationMappingRule({
      match: "exact", source: sourcePath, targetPath, role: "artifact", operation: "copy",
      mediaType: "application/json", authority: "canonical-flow-artifacts", cardinality, retention: "permanent",
    });
    const inspect = (rules) => new FlowVersionMigrationClassifier({
      target: canonicalLocation(), sourcePolicy: new FlowVersionMigrationSourcePolicy({ rules }),
      semanticValidator: semanticValidator(), outputBuilder: migrationOutputBuilder(),
    }).inspect(source);
    const authority = inspect([
      rule("one.json", "artifacts/migration/one.json", "singleton"),
      rule("two.json", "artifacts/migration/two.json", "singleton"),
    ]);
    assert.equal(authority.classification.blockers.some((blocker) => blocker.code === "DUPLICATE_AUTHORITY_SLOT"), true);
    const portable = inspect([
      rule("one.json", "artifacts/migration/Caf\u00e9.json"),
      rule("two.json", "artifacts/migration/Cafe\u0301.json"),
    ]);
    assert.equal(portable.classification.blockers.some((blocker) => blocker.code === "PORTABLE_TARGET_COLLISION"), true);
  });
  it("blocks a legacy Spec whose review evidence lacks an owner mapping", () => {
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(path.join(source, "review-evidence"), { recursive: true });
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    fs.writeFileSync(path.join(source, "review-evidence", `${REVIEW_DIGEST_A}.json`), "{}");
    const target = canonicalLocation();
    const definition = buildCurrentFlowDefinition();
    const inspection = new FlowVersionMigrationClassifier({
      target, sourcePolicy: representativeMigrationPolicy(),
      semanticValidator: semanticValidator(definition), outputBuilder: migrationOutputBuilder(),
    }).inspect(source);
    assert.equal(inspection.classification.value, "legacy");
    assert.equal(inspection.classification.migratable, false);
    assert.equal(inspection.classification.blockers.some((blocker) => blocker.path?.startsWith("review-evidence/")), true);
  });

  it("derives fresh, versioned, and conflict states from the filesystem", () => {
    const missing = path.join(temporaryRoot(), "missing");
    const freshTarget = canonicalLocation();
    const fresh = new FlowVersionMigrationClassifier({ target: freshTarget }).inspect(missing);
    assert.equal(fresh.classification.value, "fresh");
    assert.equal(fresh.classification.migratable, false);
    assert.throws(() => fresh.plan(), /cannot plan a fresh source/);

    const versionedTarget = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location: versionedTarget })
      .create(freshState(boundary, versionedTarget), { specRecord: specRecord() });
    const versioned = new FlowVersionMigrationClassifier({ target: versionedTarget, semanticValidator: semanticValidator(boundary.definition) }).inspect(missing);
    assert.equal(versioned.classification.value, "versioned");
    assert.throws(() => versioned.plan(), /cannot plan a versioned source/);

    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    const conflictTarget = canonicalLocation();
    boundary.openVersionStore({ location: conflictTarget })
      .create(freshState(boundary, conflictTarget), { specRecord: specRecord() });
    const conflict = new FlowVersionMigrationClassifier({ target: conflictTarget, semanticValidator: semanticValidator(boundary.definition) }).inspect(source);
    assert.equal(conflict.classification.value, "conflict");
    assert.throws(() => conflict.plan(), /cannot plan a conflict source/);

  });

  it("classifies partial, corrupt, and symlinked targets as blocked conflicts", () => {
    const missing = path.join(temporaryRoot(), "missing");
    const partial = canonicalLocation();
    fs.mkdirSync(partial.directory, { recursive: true });
    fs.writeFileSync(partial.flowStateFile, "{}");
    const partialResult = new FlowVersionMigrationClassifier({ target: partial }).inspect(missing).classification;
    assert.equal(partialResult.value, "conflict");
    assert.equal(partialResult.blockers[0].code, "INVALID_VERSION_TARGET");

    const corrupt = canonicalLocation();
    fs.mkdirSync(corrupt.directory, { recursive: true });
    fs.writeFileSync(corrupt.catalogFile, "not-json");
    assert.equal(new FlowVersionMigrationClassifier({ target: corrupt }).inspect(missing).classification.value, "conflict");

    const linked = canonicalLocation();
    fs.mkdirSync(path.dirname(linked.directory), { recursive: true });
    fs.symlinkSync(temporaryRoot(), linked.directory);
    const linkedResult = new FlowVersionMigrationClassifier({ target: linked }).inspect(missing).classification;
    assert.equal(linkedResult.value, "conflict");
    assert.equal(linkedResult.blockers[0].code, "INVALID_VERSION_TARGET");
  });

  it("rejects forbidden, linked, and conflicting legacy artifacts", () => {
    const target = canonicalLocation();
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "manifest.md"), "forbidden");
    const blockerCodes = () => new FlowVersionMigrationClassifier({ target }).inspect(source)
      .classification.blockers.map((blocker) => blocker.code);
    assert.equal(blockerCodes().includes("FORBIDDEN_MANIFEST"), true);
    fs.unlinkSync(path.join(source, "manifest.md"));
    fs.writeFileSync(path.join(source, "manifest.json"), "{}");
    assert.equal(blockerCodes().includes("FORBIDDEN_MANIFEST"), true);
    fs.unlinkSync(path.join(source, "manifest.json"));
    fs.writeFileSync(path.join(source, ".env"), "secret");
    assert.equal(blockerCodes().includes("UNKNOWN_HIDDEN_ARTIFACT"), true);
    fs.unlinkSync(path.join(source, ".env"));
    fs.writeFileSync(path.join(source, ".artifact-catalog.lock"), "active");
    assert.equal(blockerCodes().includes("ACTIVE_TRANSACTION_MARKER"), true);
    fs.unlinkSync(path.join(source, ".artifact-catalog.lock"));
    fs.writeFileSync(path.join(source, "unknown-visible.txt"), "unknown");
    assert.equal(blockerCodes().includes("UNKNOWN_VISIBLE_ARTIFACT"), true);
    fs.unlinkSync(path.join(source, "unknown-visible.txt"));
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.linkSync(path.join(source, "flow.json"), path.join(source, "hard.json"));
    assert.equal(blockerCodes().includes("UNSAFE_SOURCE_HARDLINK"), true);
    fs.unlinkSync(path.join(source, "hard.json"));
    fs.symlinkSync(path.join(source, "flow.json"), path.join(source, "unsafe.json"));
    assert.equal(blockerCodes().includes("UNSAFE_SOURCE_SYMLINK"), true);
    fs.unlinkSync(path.join(source, "unsafe.json"));
    fs.mkdirSync(path.join(source, "artifacts", "legacy"), { recursive: true });
    fs.writeFileSync(path.join(source, "x.json"), "root");
    fs.writeFileSync(path.join(source, "artifacts", "legacy", "x.json"), "nested");
    const inspection = new FlowVersionMigrationClassifier({
      target, sourcePolicy: new FlowVersionMigrationSourcePolicy({ rules: [
        new FlowVersionMigrationMappingRule({ match: "exact", source: "x.json", targetPath: "artifacts/migration/legacy/x.json", role: "artifact", operation: "copy", mediaType: "application/json", authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent" }),
      ] }),
    }).inspect(source);
    assert.equal(inspection.classification.blockers.some((blocker) => blocker.code === "PORTABLE_TARGET_COLLISION"), true);
    assert.throws(() => inspection.plan(), /cannot plan/);

    fs.rmSync(path.join(source, "artifacts"), { recursive: true });
    fs.unlinkSync(path.join(source, "x.json"));
    fs.writeFileSync(path.join(source, "container"), "ancestor");
    fs.mkdirSync(path.join(source, "artifacts", "legacy", "container"), { recursive: true });
    fs.writeFileSync(path.join(source, "artifacts", "legacy", "container", "child.json"), "child");
    const ancestorConflict = new FlowVersionMigrationClassifier({
      target, sourcePolicy: new FlowVersionMigrationSourcePolicy({ rules: [
        new FlowVersionMigrationMappingRule({ match: "exact", source: "container", targetPath: "artifacts/migration/legacy/container", role: "artifact", operation: "copy", mediaType: "application/octet-stream", authority: "canonical-flow-artifacts", cardinality: "collection", retention: "permanent" }),
      ] }),
    }).inspect(source);
    assert.equal(ancestorConflict.classification.blockers.some((blocker) => blocker.code === "PORTABLE_TARGET_COLLISION"), true);
    assert.throws(() => ancestorConflict.plan(), /cannot plan/);
  });

  it("rejects source drift before materializing any target files", () => {
    const target = canonicalLocation();
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    const definition = buildCurrentFlowDefinition();
    const fixture = new FlowVersionMigrationClassifier({
      target, semanticValidator: semanticValidator(definition), outputBuilder: migrationOutputBuilder(definition),
    }).inspect(source).plan().outputFixture({
      state: freshState(new CurrentFlowStateAdoptionBoundary({ definition }), target), spec: specRecord(),
    });
    fs.writeFileSync(path.join(source, "flow.json"), "changed");
    assert.throws(() => fixture.materialize(), /source inventory changed/);
    assert.equal(fs.existsSync(target.directory), false);
  });

  it("enforces migration source, role, and namespace invariants", () => {
    assert.throws(() => new FlowVersionMigrationArtifact({
      role: "spec-record", sourcePath: "flow.json", targetPath: "flow.json",
      operation: "copy", sourceHash: "a".repeat(64), size: 1,
      mediaType: "application/json", authoritySlot: singleton("flow-state", "repository-metadata"), retention: "permanent",
    }), /does not match its role/);
    assert.throws(() => new FlowVersionMigrationArtifact({
      role: "artifact", sourcePath: "input.json", targetPath: "artifacts/uncontracted.json",
      operation: "copy", sourceHash: "a".repeat(64), size: 1, mediaType: "application/json",
      authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "artifact", authority: "canonical-flow-artifacts", memberId: "uncontracted", publicationStep: "system",
      }), retention: "permanent",
    }), /canonical artifact contract/);
    assert.throws(() => new FlowVersionMigrationArtifact({
      role: "review-evidence", sourcePath: "input.json", targetPath: "steps/draft/result.json",
      operation: "copy", sourceHash: "a".repeat(64), size: 1, mediaType: "application/json",
      authoritySlot: ArtifactAuthoritySlot.singleton({
        kind: "draft", authority: "canonical-flow-artifacts", publicationStep: "system",
      }), retention: "permanent",
    }), /does not match its role/);
    const target = canonicalLocation();
    const source = path.join(temporaryRoot(), "legacy");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "flow.json"), "{}");
    fs.writeFileSync(path.join(source, "spec.json"), "{}");
    const inspection = new FlowVersionMigrationClassifier({
      target, semanticValidator: semanticValidator(), outputBuilder: migrationOutputBuilder(),
    }).inspect(source);
    assert.throws(() => new FlowVersionMigrationPlan({
      classification: inspection.classification,
      artifacts: [inspection.artifacts[0], inspection.artifacts[0]],
      inventory: inspection.inventory,
      sourcePolicy: inspection.sourcePolicy,
      semanticValidator: inspection.semanticValidator,
      outputBuilder: inspection.outputBuilder,
    }), /duplicate migration source artifact/);
  });
});

describe("Current Flow Version storage", () => {
  it("captures a lock-free catalog-bound snapshot without creating runtime state", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    fs.rmSync(location.resolve(".runtime"), { recursive: true, force: true });
    const before = fs.readdirSync(location.directory, { recursive: true }).sort();

    const snapshot = await new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
      capture: async (context) => captureCommittedCatalogEvidence(context, { source: "read-only" }),
    });

    assert.ok(snapshot instanceof FlowArtifactCatalogCommittedSnapshot);
    assert.deepEqual(snapshot.value, { source: "read-only" });
    assert.equal(snapshot.catalog.resolve("flow.json").logicalKey, "flow.state");
    assert.equal(fs.existsSync(location.resolve(".runtime")), false);
    assert.deepEqual(fs.readdirSync(location.directory, { recursive: true }).sort(), before);
  });

  it("retries a failed C0 capture when a later catalog commit makes the evidence coherent", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const next = startActivity(flow.load(), { id: "snapshot-retry-activity" });
    let changed = false;
    const snapshot = await new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
      capture: async (context) => {
        if (!changed) {
          changed = true;
          flow.apply({ activity: next });
        }
        return captureCommittedCatalogEvidence(context, { attempt: context.attempt });
      },
    });

    assert.equal(changed, true);
    assert.equal(snapshot.value.attempt, 2);
    assert.equal(snapshot.catalog.resolve("flow.json").hash, hash(fs.readFileSync(location.flowStateFile)));
    assert.equal(snapshot.catalog.resolve("activities.jsonl").hash, hash(fs.readFileSync(location.activitiesFile)));
  });

  it("keeps a successful C0 snapshot when publication commits after capture", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const prior = new FlowArtifactCatalogStore({ location }).require();
    let changed = false;

    const snapshot = await new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
      capture: async (context) => {
        const evidence = await captureCommittedCatalogEvidence(context, { attempt: context.attempt });
        if (!changed) {
          changed = true;
          const descriptors = prior.artifacts.map((descriptor, index) => new FlowArtifactDescriptor({
            ...descriptor.toJSON(), mediaType: index === 0 ? "application/octet-stream" : descriptor.mediaType,
          }));
          fs.writeFileSync(location.catalogFile, `${JSON.stringify(new FlowArtifactCatalog({ artifacts: descriptors }).toJSON())}\n`);
        }
        return evidence;
      },
    });

    assert.equal(changed, true);
    assert.equal(snapshot.value.attempt, 1);
    assert.equal(snapshot.catalog.hash, prior.hash);
    assert.notEqual(snapshot.catalog.hash, new FlowArtifactCatalogStore({ location }).require().hash);
  });

  it("requires a catalog descriptor to match the exact confirmed ledger prefix", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const catalog = new FlowArtifactCatalogSnapshotReader({ location });

    await assert.rejects(
      catalog.readCommittedSnapshot({
        limits: { maxAttempts: 1 },
        capture: async ({ catalog: current, readArtifact }) => {
          const ledger = current.resolve("activities.jsonl");
          const ledgerBytes = await readArtifact(ledger);
          return new FlowArtifactCatalogSnapshotEvidence({
            value: null,
            activityIndex: FlowArtifactActivityIndex.fromBytes(ledgerBytes),
            confirmedLedgerBytes: Buffer.from("tampered\n", "utf8"),
          });
        },
      }),
      /artifact content does not match the catalog: activities\.jsonl/,
    );
  });

  it("accepts the cataloged confirmed prefix while a journal-first suffix is incomplete", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location }).create(freshState(boundary, location), { specRecord: specRecord() });
    const confirmedLedger = fs.readFileSync(location.activitiesFile);
    fs.appendFileSync(location.activitiesFile, "{\"incomplete\":");

    const snapshot = await new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
      capture: async ({ catalog, readArtifact }) => {
        const ledgerBytes = await readArtifact(catalog.resolve("activities.jsonl"));
        const prefixEnd = ledgerBytes.indexOf(0x0a) + 1;
        const confirmedPrefix = ledgerBytes.subarray(0, prefixEnd);
        return new FlowArtifactCatalogSnapshotEvidence({
          value: { confirmedBytes: confirmedPrefix.length },
          activityIndex: FlowArtifactActivityIndex.fromBytes(confirmedPrefix),
          confirmedLedgerBytes: confirmedPrefix,
        });
      },
    });

    assert.equal(snapshot.value.confirmedBytes < fs.statSync(location.activitiesFile).size, true);
    assert.equal(snapshot.catalog.resolve("activities.jsonl").hash, hash(confirmedLedger));
  });

  it("strictly parses bounded catalog snapshots before capture", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location }).create(freshState(boundary, location), { specRecord: specRecord() });
    const serialized = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
    serialized.unexpected = true;
    fs.writeFileSync(location.catalogFile, `${JSON.stringify(serialized)}\n`);

    await assert.rejects(
      new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
        capture: async (context) => captureCommittedCatalogEvidence(context),
      }),
      /catalog snapshot cannot parse the committed catalog: artifact catalog serialized form is invalid/,
    );
  });

  it("rejects a snapshot before reading beyond its aggregate artifact budget", async () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location }).create(freshState(boundary, location), { specRecord: specRecord() });

    await assert.rejects(
      new FlowArtifactCatalogSnapshotReader({ location }).readCommittedSnapshot({
        limits: { maxAttempts: 1, maxTotalArtifactBytes: 1 },
        capture: async (context) => captureCommittedCatalogEvidence(context),
      }),
      /catalog snapshot aggregate artifact bytes exceed the limit/,
    );
  });

  it("rejects reentrant catalog reads while a transaction owns the coherent view", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location }).create(freshState(boundary, location), { specRecord: specRecord() });
    const store = new FlowArtifactCatalogStore({ location });
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("report");
    assert.throws(() => store.publish({
      ...artifact.publication({ updater: "report", mediaType: "application/json" }),
      publicationClaim: artifactPublicationClaimForStep("report"),
      write: () => new FlowArtifactCatalogStore({ location }).require(),
    }), /(?:nested Version catalog access|file lock is already held by this process)/);
    assert.equal(store.require().artifacts.some((entry) => entry.logicalKey === "report"), false);
  });

  it("recovers publication and unpublication transactions after real process death at every catalog commit boundary", async () => {
    const root = temporaryRoot();
    const location = canonicalLocation({ root });
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    boundary.openVersionStore({ location }).create(freshState(boundary, location), { specRecord: specRecord() });
    const modulePath = fileURLToPath(new URL("../../../src/lib/flow-version.js", import.meta.url));
    const authorityPath = fileURLToPath(new URL("../../../src/flow/lib/flow-artifact-authority.js", import.meta.url));
    const contractPath = fileURLToPath(new URL("../../../src/lib/flow-artifact-contract.js", import.meta.url));
    const runCrash = async (operation, phase) => {
      const mutation = operation === "publish"
        ? `store.publish({ ...artifact.publication({ updater: "report", mediaType: "application/json" }), publicationClaim: artifactPublicationClaimForStep("report"), write: () => { fs.mkdirSync(path.dirname(location.resolve(artifact.relativePath)), { recursive: true }); fs.writeFileSync(location.resolve(artifact.relativePath), "{}\\n"); if (${JSON.stringify(phase)} === "uncommitted") process.kill(process.pid, "SIGKILL"); } });`
        : `store.unpublish({ relativePath: artifact.relativePath, publicationClaim: artifactPublicationClaimForStep("report"), write: () => { fs.unlinkSync(location.resolve(artifact.relativePath)); if (${JSON.stringify(phase)} === "uncommitted") process.kill(process.pid, "SIGKILL"); } });`;
      const source = `
        import fs from "node:fs"; import path from "node:path";
        import { FlowArtifactCatalogStore, FlowVersionLocation, FlowVersionAuthorityScope } from ${JSON.stringify(modulePath)};
        import { artifactPublicationClaimForStep } from ${JSON.stringify(authorityPath)};
        import { FLOW_ARTIFACT_CONTRACTS } from ${JSON.stringify(contractPath)};
        const location = new FlowVersionLocation({ repositoryRoot: ${JSON.stringify(root)}, authorityScope: FlowVersionAuthorityScope.canonical(), specId: "508-flow-version", version: 1 });
        const store = new FlowArtifactCatalogStore({ location, faultInjector: ({ phase: point }) => { if ((${JSON.stringify(phase)} === "prepared" && point === "before-json-rename") || (${JSON.stringify(phase)} === "committed" && point === "before-json-directory-fsync")) process.kill(process.pid, "SIGKILL"); } });
        const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("report");
        ${mutation}
      `;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "ignore" });
      const [code, signal] = await once(child, "exit");
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
    };
    await runCrash("publish", "uncommitted");
    let recovered = new FlowArtifactCatalogStore({ location });
    assert.equal(recovered.require().artifacts.some((entry) => entry.logicalKey === "report"), false);
    assert.equal(fs.existsSync(location.artifact("report")), false);
    await runCrash("publish", "prepared");
    recovered = new FlowArtifactCatalogStore({ location });
    assert.equal(recovered.require().artifacts.some((entry) => entry.logicalKey === "report"), false);
    assert.equal(fs.existsSync(location.artifact("report")), false);
    await runCrash("publish", "committed");
    recovered = new FlowArtifactCatalogStore({ location });
    assert.equal(recovered.require().artifacts.some((entry) => entry.logicalKey === "report"), true);
    assert.equal(fs.readFileSync(location.artifact("report"), "utf8"), "{}\n");
    for (const phase of ["uncommitted", "prepared", "committed"]) {
      await runCrash("unpublish", phase);
      recovered = new FlowArtifactCatalogStore({ location });
      const published = recovered.require().artifacts.some((entry) => entry.logicalKey === "report");
      assert.equal(published, phase !== "committed");
      assert.equal(fs.existsSync(location.artifact("report")), phase !== "committed");
    }
  });

  it("requires a typed canonical Spec record and catalogs every root authority", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    assert.throws(() => store.create(freshState(boundary, location)), /canonical spec\.json/);
    assert.equal(fs.existsSync(location.directory), false);
    assert.throws(() => store.create(freshState(boundary, location), { specRecord: specRecord("other") }), /must match/);
    assert.doesNotThrow(() => store.create(freshState(boundary, location), { specRecord: specRecord() }));
    assert.deepEqual(store.catalog().artifacts.map((artifact) => artifact.relativePath), [
      "activities.jsonl", "flow.json", "revisions/001/spec.json", "spec.json",
    ]);
    assert.equal(store.load().schemaRevision, CURRENT_FLOW_SCHEMA_REVISION);
    assert.equal(fs.existsSync(location.resolve("flow-version.json")), false);
  });

  it("revalidates externally changed catalog bytes instead of trusting the typed cache", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    store.create(freshState(boundary, location), { specRecord: specRecord() });
    assert.equal(store.catalog().artifacts.length, 4);

    const changed = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
    changed.hash = "0".repeat(64);
    fs.writeFileSync(location.catalogFile, `${JSON.stringify(changed, null, 2)}\n`);

    assert.throws(() => store.catalog(), /catalog hash does not match/);
  });

  it("keeps flow_created, state, and catalog invisible when atomic Version creation is interrupted", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const interrupted = boundary.openVersionStore({
      location,
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("creation interrupted after durable Activity append");
      },
    });

    assert.throws(
      () => interrupted.create(freshState(boundary, location), { specRecord: specRecord() }),
      /creation interrupted after durable Activity append/,
    );
    assert.equal(fs.existsSync(location.directory), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(location.directory)).filter((entry) => /^\.001\..+\.tmp$/.test(entry)),
      [],
    );

    const recovered = boundary.openVersionStore({ location });
    recovered.create(freshState(boundary, location), { specRecord: specRecord() });
    assert.deepEqual(recovered.activities().map((entry) => entry.type), ["flow_created"]);
    assert.equal(recovered.load().confirmationOrder, 1);
    assert.deepEqual(recovered.catalog().artifacts.map((artifact) => artifact.activityId?.toString()), [
      recovered.activities()[0].id,
      recovered.activities()[0].id,
      recovered.activities()[0].id,
      recovered.activities()[0].id,
    ]);
  });

  it("accepts identity only from flow.json and rejects an identity that cannot belong to its location", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    assert.throws(
      () => store.create(freshState(boundary, location, { specId: "other-spec" }), { specRecord: specRecord() }),
      /identity must match its Version location/,
    );
    store.create(freshState(boundary, location), { specRecord: specRecord() });
    const reopened = boundary.openVersionStore({ location });
    assert.deepEqual(reopened.flowIdentity().toJSON(), store.flowIdentity().toJSON());
    assert.equal(fs.existsSync(location.resolve("flow-version.json")), false);
  });

  it("updates state and catalog atomically under exact identity", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    store.create(freshState(boundary, location), { specRecord: specRecord() });
    const applied = store.apply({ activity: startActivity(store.load()) });
    assert.deepEqual(store.load().current, applied.current);
    assert.equal(store.loadSnapshot().state.attempt.id, "attempt-1");
    fs.appendFileSync(location.flowStateFile, "tampered\n");
    assert.throws(() => store.load(), /does not match the catalog/);
  });

  it("rejects a mismatched persisted identity before committing Version side effects", () => {
    const location = canonicalLocation();
    const wrongLocation = canonicalLocation({ specId: "other-spec" });
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const store = boundary.openVersionStore({ location });
    const wrongStore = boundary.openVersionStore({ location: wrongLocation });
    store.create(freshState(boundary, location), { specRecord: specRecord() });
    wrongStore.create(freshState(boundary, wrongLocation), { specRecord: specRecord("other-spec") });

    const wrongCatalog = wrongStore.catalog();
    fs.copyFileSync(wrongLocation.flowStateFile, location.flowStateFile);
    fs.copyFileSync(wrongLocation.activitiesFile, location.activitiesFile);
    fs.copyFileSync(wrongLocation.specFile, location.specFile);
    fs.cpSync(wrongLocation.resolve("revisions"), location.resolve("revisions"), { recursive: true });
    fs.writeFileSync(location.catalogFile, JSON.stringify(wrongCatalog.toJSON()));

    const before = {
      state: fs.readFileSync(location.flowStateFile),
      activities: fs.readFileSync(location.activitiesFile),
      catalog: fs.readFileSync(location.catalogFile),
      spec: fs.readFileSync(location.specFile),
    };
    const taskLocation = location.taskArtifactLocation("T-mismatch");
    assert.throws(
      () => store.apply({ activity: addTaskActivity(wrongStore.load()) }),
      /persisted flow\.json identity does not match the opened Version location/,
    );
    assert.deepEqual(fs.readFileSync(location.flowStateFile), before.state);
    assert.deepEqual(fs.readFileSync(location.activitiesFile), before.activities);
    assert.deepEqual(fs.readFileSync(location.catalogFile), before.catalog);
    assert.deepEqual(fs.readFileSync(location.specFile), before.spec);
    assert.equal(fs.existsSync(taskLocation.directory), false);
  });
});

describe("Version collection writers", () => {
  it("excludes declared transient step logs from catalog verification", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const rawLog = location.resolve("steps/scenario-validity/output.log");
    const runtimeTransaction = location.resolve(".runtime/retry-recovery/transaction.json");
    fs.mkdirSync(path.dirname(rawLog), { recursive: true });
    fs.mkdirSync(path.dirname(runtimeTransaction), { recursive: true });
    fs.writeFileSync(rawLog, "transient");
    fs.writeFileSync(runtimeTransaction, "transient");
    assert.doesNotThrow(() => flow.catalog());
    fs.unlinkSync(rawLog);
    fs.unlinkSync(runtimeTransaction);
    assert.doesNotThrow(() => flow.load());
    assert.doesNotThrow(() => flow.loadSnapshot());
    assert.doesNotThrow(() => flow.catalog());
  });

  it("serializes Issue-log publication through the same catalog authority", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const issueLog = IssueLogStore.forVersion({ location });
    assert.throws(() => issueLog.append({ kind: "test" }, "issue-entry-1"), /active Flow leaf/);
    appendCatalogActivity(location, { id: "activity-test-execute-issue", nodeId: "test-execute", confirmationOrder: 1 });
    issueLog.append({ kind: "test" }, "issue-entry-1");
    issueLog.append({ kind: "test" }, "issue-entry-2");
    assert.equal(issueLog.read().document.entries.length, 2);
    assert.equal(flow.catalog().resolve("issue-log.json").logicalKey, "issue.log");
  });

  it("publishes same-digest evidence under distinct typed review owners without catalog collision", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const catalog = new FlowArtifactCatalogStore({ location });
    const impl = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest: REVIEW_DIGEST_A });
    const spec = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "spec-review", digest: REVIEW_DIGEST_A });
    const publish = (artifact, updater) => catalog.publish({
      ...artifact.publication({ updater, mediaType: "application/json" }),
      publicationClaim: artifactPublicationClaimForStep(updater),
      write: () => {
        const target = location.resolve(artifact.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "{}\n");
      },
    });
    publish(impl, "impl-review");
    publish(spec, "spec-review");
    publish(impl, "impl-review");
    const before = flow.catalog().resolve(impl.relativePath);
    assert.throws(() => catalog.publish({
      ...impl.publication({ updater: "impl-review", mediaType: "application/json" }),
      publicationClaim: artifactPublicationClaimForStep("impl-review"),
      write: () => fs.writeFileSync(location.resolve(impl.relativePath), "changed\n"),
    }), /immutable artifact publication/);
    assert.equal(fs.readFileSync(location.resolve(impl.relativePath), "utf8"), "{}\n");
    assert.equal(flow.catalog().resolve(impl.relativePath).hash, before.hash);
    assert.throws(() => catalog.publish({
      logicalKey: impl.logicalKey, relativePath: impl.relativePath,
      authoritySlot: ArtifactAuthoritySlot.collectionMember({
        kind: "review-evidence", authority: "canonical-flow-artifacts", memberId: "forged-member", publicationStep: "impl-review",
      }),
      publicationClaim: artifactPublicationClaimForStep("impl-review"),
      mediaType: "application/json", retention: "permanent",
      write: () => fs.writeFileSync(location.resolve(impl.relativePath), "forged\n"),
    }), /derived from its typed owner and digest/);
    assert.equal(fs.readFileSync(location.resolve(impl.relativePath), "utf8"), "{}\n");
    assert.equal(flow.catalog().resolve(impl.relativePath).hash, before.hash);
    const members = flow.catalog().artifacts.filter((entry) => entry.logicalKey === "review.evidence");
    assert.equal(members.length, 2);
    assert.notEqual(impl.relativePath, spec.relativePath);
    assert.notEqual(impl.memberId, spec.memberId);
    assert.equal(members.filter((entry) => entry.relativePath === impl.relativePath).length, 1);
  });

  it("publishes and reads the issue snapshot through its logical contract", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const catalog = new FlowArtifactCatalogStore({ location });
    catalog.writeIssueSnapshot("# Issue");
    assert.equal(catalog.read({ relativePaths: ["issue.md"], read: (value) => value.resolve("issue.md").logicalKey }), "issue.snapshot");
    assert.equal(catalog.readIssueSnapshot(), "# Issue\n");
  });

  it("enforces append-only attempt history at the catalog publication boundary", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const catalog = new FlowArtifactCatalogStore({ location });
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("test.execute");
    const publish = (attempts, activityId = null) => catalog.publish({
      ...artifact.publication({ updater: "test-execute", mediaType: "application/json", activityId }),
      publicationClaim: artifactPublicationClaimForStep("test-execute"),
      write: () => {
        const target = location.resolve(artifact.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify({ attempts })}\n`);
      },
    });
    publish([{ attempt: 1, verdict: "failed" }]);
    assert.throws(
      () => publish([{ attempt: 1, verdict: "failed" }, { attempt: 2, verdict: "passed" }]),
      /requires its updater Activity/,
    );
    appendCatalogActivity(location, { id: "activity-test-execute-1", nodeId: "test-execute", confirmationOrder: 1 });
    publish(
      [{ attempt: 1, verdict: "failed" }, { attempt: 2, verdict: "passed" }],
      new FlowActivityId("activity-test-execute-1"),
    );
    const content = artifact.contract.contentContract.parse(fs.readFileSync(location.resolve(artifact.relativePath)));
    assert.equal(content.current.attempt.value, 2);
    assert.equal(content.current.payload.verdict, "passed");
    assert.throws(() => publish([{ attempt: 1, verdict: "rewritten" }, { attempt: 2, verdict: "passed" }]), /preserve its prior prefix/);
    assert.throws(() => publish([{ attempt: 1, verdict: "failed" }]), /append-only/);
    assert.deepEqual(JSON.parse(fs.readFileSync(location.resolve(artifact.relativePath), "utf8")), {
      attempts: [{ attempt: 1, verdict: "failed" }, { attempt: 2, verdict: "passed" }],
    });
  });

  it("distinguishes first-publication producers from later updaters", () => {
    const location = canonicalLocation();
    const boundary = new CurrentFlowStateAdoptionBoundary({ definition: buildCurrentFlowDefinition() });
    const flow = boundary.openVersionStore({ location });
    flow.create(freshState(boundary, location), { specRecord: specRecord() });
    const catalog = new FlowArtifactCatalogStore({ location });
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("draft");
    const publish = (updater, content, activityId = null) => catalog.publish({
      ...artifact.publication({ updater, mediaType: "application/json", activityId }),
      publicationClaim: artifactPublicationClaimForStep(updater),
      write: () => {
        const target = location.resolve(artifact.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      },
    });
    assert.throws(() => publish("draft-refine", "refined-before-draft"), /producer is not authorized/);
    publish("draft", "initial");
    assert.throws(() => publish("draft-refine", "refined"), /requires its updater Activity/);
    appendCatalogActivity(location, { id: "activity-draft-refine-1", nodeId: "draft-refine", confirmationOrder: 1 });
    publish("draft-refine", "refined", new FlowActivityId("activity-draft-refine-1"));
    assert.equal(fs.readFileSync(location.resolve(artifact.relativePath), "utf8"), "refined");
  });

  it("preserves logicalKey and replaces activityId with the latest updater activity", () => {
    const location = canonicalLocation();
    fs.mkdirSync(location.directory, { recursive: true });
    fs.writeFileSync(location.activitiesFile, [
      { id: "activity-1", nodeId: "report", nodeKey: "impl.report", confirmationOrder: 1 },
      { id: "activity-2", nodeId: "report", nodeKey: "impl.report", confirmationOrder: 2 },
      { id: "activity-3", nodeId: "impl-review", nodeKey: "impl.impl-review", confirmationOrder: 3 },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const ledger = FLOW_ARTIFACT_CONTRACTS.resolve("flow.activities");
    const catalog = new FlowArtifactCatalogStore({ location });
    catalog.initialize(new FlowArtifactCatalog({ artifacts: [FlowArtifactDescriptor.fromFile({
      location, ...ledger.publication({ mediaType: "application/x-ndjson" }),
    })] }));
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("report");
    const publish = (activityId, content) => catalog.publish({
      ...artifact.publication({ updater: "report", mediaType: "application/json", activityId: new FlowActivityId(activityId) }),
      publicationClaim: artifactPublicationClaimForStep("report"),
      write: () => {
        const target = location.resolve(artifact.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      },
    });
    publish("activity-1", "one");
    publish("activity-2", "two");
    const descriptor = catalog.require().resolve(artifact.relativePath);
    assert.equal(descriptor.logicalKey, "report");
    assert.equal(descriptor.activityId, "activity-2");
    assert.equal(catalog.relatedActivity(artifact.relativePath).updaterStep, "report");
    catalog.publish({
      ...artifact.publication({ updater: "report", mediaType: "application/json" }),
      publicationClaim: artifactPublicationClaimForStep("report"),
      write: () => fs.writeFileSync(location.resolve(artifact.relativePath), "two"),
    });
    assert.equal(catalog.require().resolve(artifact.relativePath).activityId, "activity-2");
    assert.throws(() => catalog.publish({
      ...artifact.publication({ updater: "report", mediaType: "application/json" }),
      publicationClaim: artifactPublicationClaimForStep("report"),
      write: () => fs.writeFileSync(location.resolve(artifact.relativePath), "changed-without-activity"),
    }), /must reference a new updater Activity/);
    assert.throws(() => publish("activity-2", "changed-without-activity"), /must reference a new updater Activity/);
    assert.equal(fs.readFileSync(location.resolve(artifact.relativePath), "utf8"), "two");
    assert.throws(() => publish("activity-1", "stale"), /advance to the latest updater Activity/);
    assert.equal(fs.readFileSync(location.resolve(artifact.relativePath), "utf8"), "two");
    assert.equal(catalog.require().resolve(artifact.relativePath).activityId, "activity-2");
    assert.throws(() => publish("activity-3", "unrelated"), /updater does not match its related Activity node/);
    assert.equal(fs.readFileSync(location.resolve(artifact.relativePath), "utf8"), "two");
    assert.equal(catalog.require().resolve(artifact.relativePath).activityId, "activity-2");
  });
});
