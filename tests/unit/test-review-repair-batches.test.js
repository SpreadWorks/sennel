import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import {
  CanonicalTestReviewRepair,
  TEST_REVIEW_REPAIR_BATCH_LIMITS,
  TestReviewRepairBatchPlanner,
  TestReviewRepairFinding,
  TestReviewRepairProgress,
  TestReviewRepairScope,
  testReviewRepairProgressReceiptForSelectedContract,
} from "../../src/flow/lib/test-review-repair.js";
import {
  CanonicalWorkerTestTree,
  CanonicalWorkerTestTreeSnapshot,
} from "../../src/flow/lib/canonical-worker-artifacts.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import { SpecRevisionIdentity } from "../../src/flow/lib/spec-revision-identity.js";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const specRevision = new SpecRevisionIdentity({
  specId: "batches", revision: 1, digest: digest("spec"), byteLength: 100,
});
const candidateSource = RequirementTestCandidateSource.fromBytes({
  testPath: "tests/shared.test.js", bytes: Buffer.from("// spec: R1\n"),
});
const sourceCandidate = new RequirementTestCandidateBundle({
  bundle: new RequirementTestBundleRevision({
    requirementId: "R1", specRevision, revision: 1, paths: [candidateSource.testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId: "R1", specRevision, bundleRevision: 1, predecessorRevision: null,
      sourceAttempt: { id: "attempt-generate", sequence: 1 }, sourceFindingFingerprints: [],
    }),
  }),
  sources: [candidateSource],
});
const staleCandidateSource = RequirementTestCandidateSource.fromBytes({
  testPath: "tests/shared.test.js", bytes: Buffer.from("// spec: R1\n// stale\n"),
});
const staleSourceCandidate = new RequirementTestCandidateBundle({
  bundle: sourceCandidate.bundle,
  sources: [staleCandidateSource],
});

function finding(id, { target = "shared.test.js:R1", testPaths = undefined, createTestPaths = undefined, text = "Repair the missing assertion." } = {}) {
  return new TestReviewRepairFinding({
    findingId: id, fingerprint: digest(id), target, ...(testPaths === undefined ? {} : { testPaths }),
    ...(createTestPaths === undefined ? {} : { createTestPaths }),
    title: id, issue: text, requiredChange: text,
  });
}

function repair(findings) {
  return new CanonicalTestReviewRepair({
    state: { schemaRevision: 3, runId: "run-batches", specId: "batches", attempt: { id: "attempt-repair", sequence: 2 } }, attempt: 1,
    artifactDigest: digest("review"), evidenceId: digest("evidence"), sourceCandidate,
    blockingFindings: findings,
  });
}

function sources(...entries) {
  return entries.map(([testPath, bytes = 100]) => ({ testPath, bytes: Buffer.alloc(bytes, "x") }));
}

describe("test-review repair batches", () => {
  it("groups 13 shared-file findings deterministically and preserves one-finding batching", (t) => {
    const canonical = repair(Array.from({ length: 13 }, (_, index) => finding(`F-${index + 1}`)));
    const fixedTargetFileBytes = 227_523;
    const inputSources = sources(["shared.test.js", fixedTargetFileBytes]);
    const progress = TestReviewRepairProgress.start(canonical, inputSources);
    const plan = new TestReviewRepairBatchPlanner({ repair: canonical, testSources: inputSources }).plan(progress);
    assert.deepEqual(plan.map((batch) => batch.findingIds.length), [8, 5]);
    assert.equal(plan[0].batchId, new TestReviewRepairBatchPlanner({ repair: canonical, testSources: inputSources }).plan(progress)[0].batchId);
    const single = repair([finding("only")]);
    const singleBatch = TestReviewRepairProgress.start(single, inputSources).nextBatch(single, inputSources);
    assert.deepEqual(singleBatch.findingIds, ["only"]);
    const measure = (contracts) => {
      const started = process.hrtime.bigint();
      const payloadBytes = contracts.reduce((total, contract) => total
        + Buffer.byteLength(JSON.stringify(contract.toJSON()))
        + contract.batch.allowedTestPaths.reduce((bytes, testPath) => bytes + inputSources.find((source) => source.testPath === testPath).bytes.length, 0), 0);
      // Provider token telemetry is unavailable in a deterministic unit test.
      // Record the exact serialized worker input bytes and an explicit,
      // repeatable four-byte token estimate; real provider metrics remain a
      // release-execution concern.
      const inputTokens = Math.ceil(payloadBytes / 4);
      for (const contract of contracts) crypto.createHash("sha256").update(JSON.stringify(contract.toJSON())).digest("hex");
      return { workerCalls: contracts.length, inputTokens, durationNs: Number(process.hrtime.bigint() - started) };
    };
    const baseline = measure(canonical.blockingFindings.map((entry) => canonical.forFinding(entry.findingId, ["shared.test.js"])));
    const batched = measure(plan.map((batch) => canonical.forBatch(batch)));
    const result = {
      method: "fixed 1-file/13-findings/227523-byte fixture; exact worker payload plus supplied test bytes; deterministic 4-byte token estimate",
      baseline, batched,
      reductions: {
        workerCalls: 1 - batched.workerCalls / baseline.workerCalls,
        inputTokens: 1 - batched.inputTokens / baseline.inputTokens,
        payloadPreparationDuration: 1 - batched.durationNs / baseline.durationNs,
      },
    };
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.reductions.workerCalls >= 0.4);
    assert.ok(result.reductions.inputTokens >= 0.4);
    assert.ok(Number.isFinite(result.reductions.payloadPreparationDuration));
  });

  it("supports multi-path findings and never assigns GLOBAL to a lexical existing file", () => {
    const paths = ["a.test.js", "b.test.js"];
    const multi = new TestReviewRepairScope({ finding: finding("multi", { target: "GLOBAL", testPaths: paths }), testPaths: paths });
    assert.deepEqual(multi.allowedTestPaths, paths);
    assert.equal(multi.operation, "modify");
    const global = new TestReviewRepairScope({ finding: finding("global", { target: "GLOBAL" }), testPaths: paths });
    assert.equal(global.operation, "create");
    assert.notEqual(global.targetFile, "a.test.js");
    const explicit = new TestReviewRepairScope({ finding: finding("explicit", { target: "a.test.js:R1", testPaths: paths }), testPaths: paths });
    assert.deepEqual(explicit.allowedTestPaths, paths);
    const catalogRelative = new TestReviewRepairScope({
      finding: finding("catalog-relative", { target: "tests/a.test.js — R1 test" }), testPaths: paths,
    });
    assert.deepEqual(catalogRelative.allowedTestPaths, ["a.test.js"]);
    assert.throws(
      () => new TestReviewRepairScope({ finding: finding("existing-create", { target: "GLOBAL", createTestPaths: ["a.test.js"] }), testPaths: paths }),
      /already exists/,
    );
    const fallbackCollision = digest("fallback-collision").slice(0, 16);
    assert.throws(
      () => new TestReviewRepairScope({
        finding: new TestReviewRepairFinding({ findingId: "fallback-collision", fingerprint: `${fallbackCollision}${"0".repeat(48)}`, target: "GLOBAL", title: "fallback", issue: "fallback", requiredChange: "fallback" }),
        testPaths: [`repair-${fallbackCollision}.test.js`],
      }),
      /deterministic create repair target already exists/,
    );
  });

  it("splits deterministically at every configured batch cap", () => {
    const shared = repair([finding("one"), finding("two")]);
    const source = sources(["shared.test.js", 100], ["a.test.js", 80], ["b.test.js", 80], ["c.test.js", 80]);
    const progress = TestReviewRepairProgress.start(shared, source);
    const plan = (findings, limits) => new TestReviewRepairBatchPlanner({ repair: repair(findings), testSources: source, limits }).plan(TestReviewRepairProgress.start(repair(findings), source));
    assert.equal(plan(shared.blockingFindings, { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, findingCount: 1 }).length, 2);
    assert.equal(plan([finding("text-one", { text: "x".repeat(700) }), finding("text-two", { text: "x".repeat(700) })], { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, findingTextChars: 2_000 }).length, 2);
    assert.equal(plan([
      finding("paths-one", { target: "a.test.js:R1", testPaths: ["a.test.js", "b.test.js"] }),
      finding("paths-two", { target: "b.test.js:R1", testPaths: ["b.test.js", "c.test.js"] }),
    ], { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, pathCount: 2 }).length, 2);
    assert.equal(plan([
      finding("bytes-one", { target: "a.test.js:R1", testPaths: ["a.test.js", "b.test.js"] }),
      finding("bytes-two", { target: "b.test.js:R2", testPaths: ["b.test.js", "c.test.js"] }),
    ], { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, targetFileBytes: 160 }).length, 2);
    void progress;
  });

  it("fails closed for stale, partial, mismatched, or scope-escaping persisted batch receipts", () => {
    const canonical = repair([finding("receipt-one"), finding("receipt-two")]);
    const stagedSources = sources(["shared.test.js", 128]);
    const batch = TestReviewRepairProgress.start(canonical, stagedSources).nextBatch(canonical, stagedSources);
    const receipt = {
      batchId: batch.batchId,
      findingIds: [...batch.findingIds],
      beforeTreeDigest: digest("before"), afterTreeDigest: digest("after"),
      changedPaths: [{ path: "shared.test.js", beforeDigest: digest("before-file"), afterDigest: digest("after-file") }],
      sourceCandidate: sourceCandidate.toJSON(),
      handoffDigest: digest("handoff"), requestDigest: digest("request"), payloadDigest: digest("payload"),
    };
    const completed = TestReviewRepairProgress.start(canonical, stagedSources).markBatchComplete(canonical, batch, receipt, stagedSources);
    const selectedContract = canonical.forBatch(batch).toJSON();
    const recognize = (progressDocument) => testReviewRepairProgressReceiptForSelectedContract({
      state: { schemaRevision: 3, runId: "run-batches", specId: "batches", attempt: { id: "attempt-repair", sequence: 2 } },
      progressDocument, selectedContract, requestDigest: receipt.requestDigest,
    });
    assert.equal(recognize(completed.toJSON()), receipt.handoffDigest);
    const persisted = completed.toJSON();
    persisted.entries[1].handoff.requestDigest = digest("different-request");
    assert.throws(() => TestReviewRepairProgress.fromJSON(persisted, canonical), /exact receipt/);
    assert.equal(recognize(persisted), null, "replay recognition rejects mismatched full receipts even with one matching digest");
    const mismatchedFindingIds = completed.toJSON();
    mismatchedFindingIds.entries.forEach((entry) => { entry.handoff.findingIds = [batch.findingIds[0]]; });
    assert.equal(recognize(mismatchedFindingIds), null);
    const staleReceipt = completed.toJSON();
    staleReceipt.entries.forEach((entry) => { entry.handoff.sourceCandidate = staleSourceCandidate.toJSON(); });
    assert.equal(recognize(staleReceipt), null);
    const scopeEscape = completed.toJSON();
    scopeEscape.entries.forEach((entry) => { entry.handoff.changedPaths = [{ path: "escape.test.js", beforeDigest: null, afterDigest: digest("escape") }]; });
    assert.equal(recognize(scopeEscape), null);
    const partialReplay = completed.toJSON();
    partialReplay.entries[1].status = "pending";
    partialReplay.entries[1].handoff = null;
    assert.equal(recognize(partialReplay), null);
    assert.throws(
      () => TestReviewRepairProgress.start(canonical, stagedSources).markBatchComplete(canonical, batch, {
        ...receipt, sourceCandidate: staleSourceCandidate.toJSON(),
      }, stagedSources),
      /source candidate is stale/,
    );
    assert.throws(
      () => TestReviewRepairProgress.start(canonical, stagedSources).markBatchComplete(canonical, batch, {
        ...receipt, changedPaths: [{ path: "escape.test.js", beforeDigest: null, afterDigest: digest("escape") }],
      }, stagedSources),
      /escape its batch capability/,
    );
    const partial = completed.toJSON();
    partial.entries[1].status = "pending";
    partial.entries[1].handoff = null;
    assert.throws(() => TestReviewRepairProgress.fromJSON(partial, canonical), /completed finding group/);
  });

  it("fails closed when a bounded worker omits an allowed file, escapes scope, or composes against mutated unchanged bytes", () => {
    const originalA = Buffer.from("// a\n");
    const originalB = Buffer.from("// b\n");
    const baseline = new CanonicalWorkerTestTreeSnapshot([
      { targetRelativePath: "tests/a.test.js", digest: digest(originalA), byteLength: originalA.length },
      { targetRelativePath: "tests/b.test.js", digest: digest(originalB), byteLength: originalB.length },
    ]);
    const compose = (entries, allowed = ["a.test.js", "b.test.js"], canonicalEntries = [
      { testPath: "a.test.js", bytes: originalA }, { testPath: "b.test.js", bytes: originalB },
    ]) => new CanonicalWorkerTestTree(entries).repairComposition({ baseline, allowedTestPaths: allowed, canonicalEntries });
    assert.throws(() => compose([{ targetRelativePath: "tests/a.test.js", bytes: Buffer.from("// changed\n") }]), /omitted/);
    assert.throws(() => compose([
      { targetRelativePath: "tests/a.test.js", bytes: Buffer.from("// changed\n") },
      { targetRelativePath: "tests/b.test.js", bytes: originalB },
      { targetRelativePath: "tests/escape.test.js", bytes: Buffer.from("// escape\n") },
    ]), /outside/);
    assert.throws(() => compose([
      { targetRelativePath: "tests/a.test.js", bytes: Buffer.from("// changed\n") },
    ], ["a.test.js"], [
      { testPath: "a.test.js", bytes: originalA }, { testPath: "b.test.js", bytes: Buffer.from("// stale\n") },
    ]), /snapshot changed/);
  });
});
