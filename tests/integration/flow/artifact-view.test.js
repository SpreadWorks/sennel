import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { removeTmpDir, createTmpDir } from "../../support/builders/tmp-dir.js";
import { FreshFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  ArtifactViewRegistry,
  ArtifactViewRegistryEntry,
  FLOW_ARTIFACT_VIEW_REGISTRY,
} from "../../../src/flow/lib/artifact-view-registry.js";
import {
  ArtifactViewDocument,
  ArtifactViewAcceptanceDecision,
  ArtifactViewFlowFindingProjection,
  ArtifactViewResolvedReference,
  ArtifactViewSource,
  ArtifactViewTarget,
  ArtifactViewReader,
  assertAcceptanceHardBlockerProjection,
  embeddedAcceptanceDecision,
} from "../../../src/flow/lib/artifact-view-reader.js";
import {
  ARTIFACT_VIEW_LOCALIZATION_KEYS,
  ArtifactFullViewRenderer,
  ArtifactViewFindingDetail,
  ArtifactViewLocalizer,
} from "../../../src/flow/lib/artifact-view-renderer.js";
import { ArtifactFullViewFingerprint } from "../../../src/flow/lib/artifact-view-cache.js";
import {
  artifactViewSha256,
  stableArtifactViewJson,
} from "../../../src/flow/lib/artifact-view-fingerprint.js";
import { ArtifactViewService, ArtifactViewServiceError } from "../../../src/flow/lib/artifact-view-service.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { FlowArtifactCatalog, FlowArtifactCatalogStore, FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";

const roots = [];

function root() {
  const value = createTmpDir("artifact-view-");
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

function taskRecord() {
  return {
    id: "T1",
    title: "Render the full view",
    goal: "Keep every task inline in the deterministic Markdown.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
    acceptance: ["Markdown shows the task purpose."],
  };
}

function specRecord() {
  return {
    goal: "Keep the canonical view deterministic.",
    background: "The source text remains intact.",
    scope: { in: ["Read cataloged sources"], out: ["Change Flow state"] },
    constraints: ["Node built-ins only."],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    requirements: [{ id: "R1", desc: "Render the verified requirement.", task_ids: ["T1"] }],
    acceptance_criteria: ["The human view is stable."],
    clarifications: [{ q: "Who reads it?", a: "A person." }],
    alternatives_considered: [],
    open_questions: [],
  };
}

function completeSpecRecord() {
  return { ...specRecord(), tasks: [taskRecord()] };
}

function activeFixture() {
  const directory = root();
  const flowManager = makeFlowManager(directory);
  const fixture = new FreshFlowFixture({
    flowManager,
    specId: "514-artifact-view",
    specRecord: specRecord(),
  }).create().addTask(taskRecord()).registerActive();
  return { directory, flowManager, fixture };
}

function source(logicalKey, relativePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  return new ArtifactViewSource({
    logicalKey,
    relativePath,
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes,
  });
}

function attemptHistorySource(logicalKey, relativePath, payload) {
  const bytes = Buffer.from(`${JSON.stringify({
    attempts: [{ attempt: 1, artifact: { logicalKey, payload } }],
  })}\n`, "utf8");
  return new ArtifactViewSource({
    logicalKey,
    relativePath,
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes,
  });
}

function catalogArtifact(location, logicalKey, relativePath, bytes) {
  const filePath = location.resolve(relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
  return FlowArtifactDescriptor.fromFile({
    location,
    logicalKey,
    authoritySlot: contract.authoritySlotForPath(relativePath),
    relativePath,
    mediaType: "application/json",
    retention: contract.retention.toString(),
  });
}

function addCatalogArtifacts(location, catalog, descriptors) {
  const updated = new FlowArtifactCatalog({ artifacts: [...catalog.artifacts, ...descriptors] });
  fs.writeFileSync(location.catalogFile, `${JSON.stringify(updated.toJSON(), null, 2)}\n`, "utf8");
}

function acceptanceDocument(location, {
  spec = completeSpecRecord(),
  flowFindings = { version: 2, entries: [] },
  originalOverride = {},
  decision = null,
  reviewOverride = {},
} = {}) {
  const target = new ArtifactViewTarget({ location, active: true });
  const entry = FLOW_ARTIFACT_VIEW_REGISTRY.require("acceptance.review");
  const deferred = {
    findingId: "F1",
    sourceStep: "impl-review",
    sourceArtifact: "steps/impl/review/result.json",
    sourceFindingId: "proposal-1",
    finalDisposition: "still_open",
    evidenceRefs: ["steps/impl/review/result.json#proposal-1"],
  };
  const review = {
    version: 2,
    verdict: "user_decision_required",
    requirementJudgments: [{
      requirementId: "R1",
      status: "notVerifiable",
      requestRefs: ["flow.request"],
      requirementRefs: ["spec.json#R1"],
      diffRefs: [],
      repairRefs: ["repair.json"],
      testRefs: [],
      missingEvidence: ["The source result needs a decision."],
    }],
    mechanicalBlockers: [],
    hardBlockers: [deferred],
    deferredFindings: [deferred],
    userDecision: null,
    ...reviewOverride,
  };
  const original = {
    fingerprint: "b".repeat(64),
    title: "Implementation review proposal",
    issue: "The user-visible source body remains exact.",
    file: "src/flow/lib/artifact-view.js",
    suggestion: "Use the bounded catalog reader.",
    requirementId: "R1",
    opaqueManagement: { nested: "must not be rendered" },
    ...originalOverride,
  };
  const originalSource = source("impl.review", deferred.sourceArtifact, { proposals: [original] });
  const reference = new ArtifactViewResolvedReference({
    ...deferred,
    fingerprint: original.fingerprint,
    source: originalSource,
    finding: original,
    flowFinding: new ArtifactViewFlowFindingProjection({
      findingId: deferred.findingId,
      sourceStep: deferred.sourceStep,
      sourceArtifact: deferred.sourceArtifact,
      sourceFindingId: deferred.sourceFindingId,
      fingerprint: original.fingerprint,
      rationale: "Retry exhaustion left this finding for an explicit acceptance decision.",
      disposition: "deferred",
      finalDisposition: deferred.finalDisposition,
    }),
  });
  const decisionSource = decision === null
    ? null
    : source("acceptance.decision", "steps/acceptance-decision/result.json", decision);
  const decisionValue = decisionSource === null
    ? null
    : new ArtifactViewAcceptanceDecision({
      choice: decision.choice,
      decidedAt: decision.decidedAt,
      source: decisionSource,
    });
  return new ArtifactViewDocument({
    target,
    entry,
    primary: source("acceptance.review", "steps/acceptance-review/result.json", review),
    primaryValue: review,
    dependencies: [
      source("spec.record", "spec.json", spec),
      source("flow.findings", "steps/flow-findings.json", flowFindings),
      ...(decisionSource === null ? [] : [decisionSource]),
    ],
    references: [reference],
    decision: decisionValue,
  });
}

describe("artifact human views", () => {
  it("resolves same-ID deferred findings by their exact fingerprints through the catalog reader", () => {
    const { fixture } = activeFixture();
    const location = fixture.location();
    const baseCatalog = new FlowArtifactCatalogStore({ location }).require();
    const sourceArtifact = "steps/impl/review/result.json";
    const sourceFindingId = "proposal-shared";
    const fingerprints = ["a", "b", "c", "d"].map((value) => value.repeat(64));
    const findingIds = ["DF-1", "DF-2", "DF-3", "DF-4"];
    const originals = fingerprints.map((fingerprint, index) => ({
      proposalId: sourceFindingId,
      fingerprint,
      title: `Original ${index + 1}`,
      issue: `Issue ${index + 1}`,
      suggestion: `Suggestion ${index + 1}`,
      requirementId: "R1",
    }));
    const deferredFindings = findingIds.map((findingId, index) => ({
      findingId,
      sourceStep: "impl-review",
      sourceArtifact,
      sourceFindingId,
      finalDisposition: "still_open",
      evidenceRefs: [`${sourceArtifact}#${sourceFindingId}`],
    }));
    const acceptanceReview = {
      version: 2,
      repairFingerprint: "c".repeat(64),
      mechanicalBlockers: [],
      hardBlockers: deferredFindings,
      requirementJudgments: [{
        requirementId: "R1",
        status: "notVerifiable",
        requestRefs: ["flow.request"],
        requirementRefs: ["spec.json#R1"],
        diffRefs: [],
        repairRefs: ["repair.json"],
        testRefs: [],
        missingEvidence: ["The source result needs a decision."],
      }],
      deferredFindings,
      userDecision: null,
      verdict: "user_decision_required",
    };
    const histories = [
      ["acceptance.review", "steps/acceptance-review/result.json", {
        attempts: [{ attempt: 1, artifact: { logicalKey: "acceptance.review", payload: acceptanceReview } }],
      }],
      ["flow.findings", "steps/flow-findings.json", {
        version: 2,
        entries: findingIds.map((findingId, index) => ({
          findingId,
          sourceStep: "impl-review",
          sourceArtifact,
          sourceFindingId,
          runId: fixture.state().runId,
          fingerprint: fingerprints[index],
          disposition: "deferred",
          rationale: `Deferred ${findingId}.`,
          retryExhausted: true,
          attempts: 1,
          round: index + 1,
          completionKind: "deferred",
          finalDisposition: "still_open",
        })),
      }],
      ["impl.review", sourceArtifact, {
        attempts: [{ attempt: 1, artifact: { logicalKey: "impl.review", payload: { blockingFindings: originals } } }],
      }],
    ];
    const descriptors = histories.map(([logicalKey, relativePath, value]) => catalogArtifact(
      location,
      logicalKey,
      relativePath,
      Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    ));
    addCatalogArtifacts(location, baseCatalog, descriptors);

    const catalogBefore = fs.readFileSync(location.catalogFile);
    const sourcesBefore = histories.map(([, relativePath]) => fs.readFileSync(location.resolve(relativePath)));
    const document = new ArtifactViewReader({
      target: new ArtifactViewTarget({ location, active: true }),
    }).read("acceptance.review");

    assert.deepEqual(document.references.map((reference) => reference.findingId), findingIds);
    assert.deepEqual(document.references.map((reference) => reference.fingerprint), fingerprints);
    assert.deepEqual(document.references.map((reference) => reference.finding.title),
      originals.map((original) => original.title));
    assert.deepEqual(document.references.map((reference) => reference.finding.fingerprint), fingerprints);
    assert.deepEqual(fs.readFileSync(location.catalogFile), catalogBefore, "catalog read leaves canonical catalog bytes unchanged");
    assert.deepEqual(histories.map(([, relativePath]) => fs.readFileSync(location.resolve(relativePath))), sourcesBefore,
      "catalog read leaves source artifacts unchanged");
  });

  it("uses one deterministic fingerprint serialization that preserves array order", () => {
    const reorderedKeys = { b: ["first", "second"], a: { y: 2, x: 1 } };
    const canonical = { a: { x: 1, y: 2 }, b: ["first", "second"] };
    assert.equal(stableArtifactViewJson(reorderedKeys), stableArtifactViewJson(canonical));
    assert.notEqual(
      stableArtifactViewJson(canonical),
      stableArtifactViewJson({ a: { x: 1, y: 2 }, b: ["second", "first"] }),
    );
    assert.equal(
      artifactViewSha256(stableArtifactViewJson(reorderedKeys)),
      artifactViewSha256(stableArtifactViewJson(canonical)),
    );
  });

  it("keeps the renderer target allowlist closed against public index mutation", () => {
    const registry = new ArtifactViewRegistry([
      new ArtifactViewRegistryEntry({ logicalKey: "spec.record", rendererRevision: "1" }),
    ]);
    assert.equal(Object.hasOwn(registry, "byLogicalKey"), false);
    assert.throws(() => {
      registry.byLogicalKey = new Map([
        ["unreviewed.record", new ArtifactViewRegistryEntry({ logicalKey: "unreviewed.record", rendererRevision: "1" })],
      ]);
    }, /extensible|read only|Cannot add property/i);
    assert.equal(registry.has("unreviewed.record"), false);
    assert.throws(() => registry.require("unreviewed.record"), /not registered/);
  });

  it("renders a cataloged spec deterministically, caches it, and strips cache metadata from the returned body", () => {
    const { flowManager, fixture } = activeFixture();
    const service = new ArtifactViewService({ config: { lang: "en" }, flowManager });
    const first = service.full({ logicalKey: "spec.record", activeState: fixture.state() });
    const second = service.full({ logicalKey: "spec.record", activeState: fixture.state() });
    const cachePath = path.join(first.cacheStore.directory, "spec.record.full.md");

    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.fullView.semanticUnits.map((unit) => unit.markdown).join(""), first.markdown);
    assert.match(first.markdown, /#### Purpose\nKeep every task inline/);
    assert.match(fs.readFileSync(cachePath, "utf8"), /^<!-- sennel-flow-artifact-view /);
    assert.equal(second.markdown.startsWith("<!--"), false);
  });

  it("returns the metadata-stripped stored body on a matching full-cache hit and invalidates a mismatched cache", () => {
    const { flowManager, fixture } = activeFixture();
    const english = new ArtifactViewService({ config: { lang: "en" }, flowManager });
    const first = english.full({ logicalKey: "spec.record", activeState: fixture.state() });
    const cachePath = path.join(first.cacheStore.directory, "spec.record.full.md");
    const cached = fs.readFileSync(cachePath, "utf8");
    fs.writeFileSync(cachePath, cached.replace("Keep the canonical view deterministic.", "stored cache body"));

    const cacheHit = english.full({ logicalKey: "spec.record", activeState: fixture.state() });
    const stale = fs.readFileSync(cachePath, "utf8").replace(/"fingerprint":"[a-f0-9]{64}"/, `"fingerprint":"${"0".repeat(64)}"`);
    fs.writeFileSync(cachePath, stale);
    const repaired = english.full({ logicalKey: "spec.record", activeState: fixture.state() });
    const japanese = new ArtifactViewService({ config: { lang: "ja" }, flowManager })
      .full({ logicalKey: "spec.record", activeState: fixture.state() });

    assert.equal(cacheHit.cache.hit, true);
    assert.match(cacheHit.markdown, /stored cache body/);
    assert.equal(cacheHit.markdown.startsWith("<!--"), false);
    assert.notEqual(cacheHit.markdown, cacheHit.fullView.markdown);
    assert.equal(repaired.cache.hit, false);
    assert.match(repaired.markdown, /Keep the canonical view deterministic\./);
    assert.equal(japanese.cache.hit, false);
    assert.match(japanese.markdown, /^# 仕様/m);
    assert.notEqual(japanese.fullFingerprint.toString(), first.fullFingerprint.toString());
  });

  it("keeps source failures fatal but reports cache write failure as a localized non-fatal warning", () => {
    const { flowManager, fixture } = activeFixture();
    const state = fixture.state();
    const writeFailure = new ArtifactViewService({
      config: { lang: "ja" },
      flowManager,
      cacheFaultInjector: () => { throw new Error("simulated cache failure"); },
    }).full({ logicalKey: "spec.record", activeState: state });

    assert.equal(writeFailure.cache.hit, false);
    assert.equal(writeFailure.cacheWarning?.code, "ARTIFACT_VIEW_CACHE_NOT_SAVED");
    assert.equal(writeFailure.cacheWarning?.message, "アーティファクトビューは生成されましたが、キャッシュを保存できませんでした。");

    fs.appendFileSync(fixture.location().specFile, "\ncorrupt");
    assert.throws(
      () => new ArtifactViewService({ config: { lang: "en" }, flowManager })
        .full({ logicalKey: "spec.record", activeState: state }),
      (error) => error instanceof ArtifactViewServiceError
        && error.code === "ARTIFACT_VIEW_READ_FAILED"
        && /catalog|hash|content changed/i.test(error.message),
    );
  });

  it("classifies source and deterministic renderer failures separately", () => {
    const { flowManager, fixture } = activeFixture();
    class FailingRenderer extends ArtifactFullViewRenderer {
      render() { throw new Error("simulated renderer failure"); }
    }
    assert.throws(
      () => new ArtifactViewService({
        config: { lang: "en" },
        flowManager,
        renderer: new FailingRenderer({ config: { lang: "en" } }),
      }).full({ logicalKey: "spec.record", activeState: fixture.state() }),
      (error) => error instanceof ArtifactViewServiceError
        && error.code === "ARTIFACT_VIEW_RENDER_FAILED"
        && /simulated renderer failure/.test(error.message),
    );
    assert.throws(
      () => new ArtifactViewService({ config: { lang: "en" }, flowManager })
        .full({ logicalKey: "spec.record" }),
      (error) => error instanceof ArtifactViewServiceError
        && error.code === "ARTIFACT_VIEW_READ_FAILED"
        && /target resolution/i.test(error.message),
    );
  });

  it("uses localized typed finding renderers without dumping arbitrary management fields or duplicate remaining risks", () => {
    const { fixture } = activeFixture();
    const document = acceptanceDocument(fixture.location());
    const view = new ArtifactFullViewRenderer({ config: { lang: "ja" } }).render(document);
    const remainingRisk = view.semanticUnits.filter((unit) => unit.kind === "remainingRisk");

    assert.match(view.markdown, /^# 受入レビュー/m);
    assert.match(view.markdown, /\*\*発生ステップ\*\*: impl-review/);
    assert.match(view.markdown, /\*\*推奨事項\*\*:/);
    assert.match(view.markdown, /\*\*根拠\*\*: Retry exhaustion left this finding for an explicit acceptance decision\./);
    assert.match(view.markdown, /\*\*処置\*\*: deferred/);
    assert.match(view.markdown, /The user-visible source body remains exact\./);
    assert.equal(view.markdown.includes("opaqueManagement"), false);
    assert.equal(view.markdown.includes("nested"), false);
    assert.equal(remainingRisk.filter((unit) => unit.findingId === "F1").length, 1);
    assert.deepEqual(remainingRisk.filter((unit) => unit.findingId === "F1").map((unit) => unit.riskId), ["deferred:F1"]);
  });

  it("fingerprints primary, static, optional, and dynamic acceptance sources so full and summary caches invalidate", () => {
    const { fixture } = activeFixture();
    const renderer = new ArtifactFullViewRenderer({ config: { lang: "en" } });
    const render = (options) => renderer.render(acceptanceDocument(fixture.location(), options));
    const baseline = render();
    const primaryChanged = render({ reviewOverride: { reportRefs: ["report-v2"] } });
    const staticChanged = render({
      spec: { ...completeSpecRecord(), background: "A changed cataloged static dependency." },
    });
    const findingsChanged = render({ flowFindings: { version: 2, entries: [{ findingId: "flow-finding-2" }] } });
    const optionalDecision = render({ decision: { choice: "abort", decidedAt: "2026-08-15T00:00:00.000Z" } });
    const dynamicChanged = render({ originalOverride: { suggestion: "A changed original source finding." } });
    const baselineFullFingerprint = new ArtifactFullViewFingerprint({ fullView: baseline });
    const fingerprint = (view) => new ArtifactFullViewFingerprint({ fullView: view }).toString();
    const baselineFingerprint = baselineFullFingerprint.toString();

    for (const candidate of [primaryChanged, staticChanged, findingsChanged, optionalDecision, dynamicChanged]) {
      assert.notEqual(fingerprint(candidate), baselineFingerprint);
    }
    assert.notEqual(
      crypto.createHash("sha256").update(dynamicChanged.markdown).digest("hex"),
      crypto.createHash("sha256").update(baseline.markdown).digest("hex"),
      "summary cache full-hash input changes with the original finding text",
    );
    assert.deepEqual(
      baseline.sourceArtifacts.map((entry) => entry.logicalKey).sort(),
      ["acceptance.review", "flow.findings", "impl.review", "spec.record"],
    );
    assert.ok(optionalDecision.sourceArtifacts.some((entry) => entry.logicalKey === "acceptance.decision"));
    assert.deepEqual(baselineFullFingerprint.inputs.target, {
      specId: baseline.document.target.specId,
      version: baseline.document.target.version,
    });
    assert.equal(baselineFullFingerprint.inputs.registry.logicalKey, "acceptance.review");
    const originalFingerprint = baselineFullFingerprint.toString();
    assert.throws(
      () => baselineFullFingerprint.inputs.registry.dependencies.push({ logicalKey: "unapproved.record", required: true }),
      /extensible|read only|object is not extensible/i,
    );
    assert.equal(baselineFullFingerprint.toString(), originalFingerprint);
  });

  it("covers explicit impl, test, draft, and gate finding shapes without recursive field enumeration", () => {
    const localizer = new ArtifactViewLocalizer({ config: { lang: "en" } });
    const cases = [
      [{ title: "Impl proposal", file: "src/a.js", issue: "Implement this", suggestion: "Apply this change", requirementId: "R1" }, ["Impl proposal", "src/a.js", "Apply this change", "R1"]],
      [{ target: "tests/a.test.js", requiredChange: "Add regression coverage", improvement: "Name the boundary", whyNonBlocking: "It is advisory" }, ["tests/a.test.js", "Add regression coverage", "Name the boundary", "It is advisory"]],
      [{ title: "Draft finding", target: "scope", rationale: "The draft lacks a decision", evidence: "draft.json" }, ["Draft finding", "scope", "The draft lacks a decision", "draft.json"]],
      [{ guardrail_id: "GR-1", target: "src/gate.js", where: "line 12", why_violates: "Breaks the guardrail", ignoredManagement: { hash: "not for people" } }, ["GR-1", "src/gate.js", "line 12", "Breaks the guardrail"]],
    ];
    for (const [finding, expected] of cases) {
      const markdown = new ArtifactViewFindingDetail(finding).toMarkdown(localizer);
      for (const text of expected) assert.match(markdown, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(markdown.includes("ignoredManagement"), false);
      assert.equal(markdown.includes("hash"), false);
    }
  });

  it("rejects a corrupt hard-blocker projection and validates embedded and optional cataloged decisions", () => {
    const deferred = {
      findingId: "F1",
      sourceStep: "impl-review",
      sourceArtifact: "steps/impl/review/result.json",
      sourceFindingId: "proposal-1",
      finalDisposition: "still_open",
    };
    assert.equal(assertAcceptanceHardBlockerProjection({ deferredFindings: [deferred], hardBlockers: [deferred] }).hardBlockers.length, 1);
    assert.throws(
      () => assertAcceptanceHardBlockerProjection({ deferredFindings: [deferred], hardBlockers: [] }),
      /hardBlockers must equal unresolved deferredFindings/,
    );
    assert.throws(
      () => assertAcceptanceHardBlockerProjection({
        deferredFindings: [deferred],
        hardBlockers: [{ ...deferred, sourceFindingId: "wrong-source" }],
      }),
      /not linked to deferred finding/,
    );
    const deferredSecond = {
      ...deferred,
      findingId: "F2",
      sourceFindingId: "proposal-2",
    };
    assert.throws(
      () => assertAcceptanceHardBlockerProjection({
        deferredFindings: [deferred, deferredSecond],
        hardBlockers: [deferredSecond, deferred],
      }),
      /source order/,
    );
    const review = {
      verdict: "user_decision_required",
      repairFingerprint: "a".repeat(64),
      userDecision: { choice: "abort", decidedAt: "2026-08-15T00:00:00.000Z" },
    };
    const embedded = embeddedAcceptanceDecision(review);
    assert.equal(embedded.choice, "abort");
    assert.equal(embedded.source, null);
    assert.equal(embeddedAcceptanceDecision({ verdict: "pass", userDecision: null }), null);
    const reviewSource = attemptHistorySource("acceptance.review", "steps/acceptance-review/result.json", review);
    const matching = ArtifactViewAcceptanceDecision.resolve({
      review,
      reviewAttempt: 1,
      reviewSource,
      decisionSource: attemptHistorySource("acceptance.decision", "steps/acceptance-decision/result.json", {
        version: 1,
        choice: "abort",
        decidedAt: "2026-08-15T00:00:00.000Z",
        acceptanceReviewAttempt: 1,
        acceptanceReviewDigest: reviewSource.hash,
        repairFingerprint: review.repairFingerprint,
      }),
    });
    assert.equal(matching.choice, "abort");
    assert.notEqual(matching.source, null);
    assert.throws(
      () => ArtifactViewAcceptanceDecision.resolve({
        review,
        reviewAttempt: 1,
        reviewSource,
        decisionSource: attemptHistorySource("acceptance.decision", "steps/acceptance-decision/result.json", {
          version: 1,
          choice: "accept_risk_and_continue",
          decidedAt: "2026-08-15T00:00:00.000Z",
          acceptanceReviewAttempt: 1,
          acceptanceReviewDigest: reviewSource.hash,
          repairFingerprint: review.repairFingerprint,
        }),
      }),
      /conflicts with canonical acceptance\.decision/,
    );
    assert.throws(
      () => ArtifactViewAcceptanceDecision.resolve({
        review: { ...review, userDecision: null },
        reviewAttempt: 1,
        reviewSource,
        decisionSource: attemptHistorySource("acceptance.decision", "steps/acceptance-decision/result.json", {
          version: 1,
          choice: "abort",
          decidedAt: "2026-08-15T00:00:00.000Z",
          acceptanceReviewAttempt: 2,
          acceptanceReviewDigest: reviewSource.hash,
          repairFingerprint: review.repairFingerprint,
        }),
      }),
      /not linked to the current acceptance\.review attempt/,
    );
    assert.throws(
      () => ArtifactViewAcceptanceDecision.resolve({
        review, reviewAttempt: 1, reviewSource,
        decisionSource: attemptHistorySource("acceptance.decision", "steps/acceptance-decision/result.json", {
          version: 1, choice: "abort", decidedAt: "2026-08-15T00:00:00.000Z",
          acceptanceReviewAttempt: 1, acceptanceReviewDigest: "b".repeat(64), repairFingerprint: review.repairFingerprint,
        }),
      }),
      /review digest does not match acceptance\.review/,
    );
    assert.throws(
      () => embeddedAcceptanceDecision({
        verdict: "pass",
        userDecision: { choice: "abort", decidedAt: "2026-08-15T00:00:00.000Z" },
      }),
      /requires user_decision_required verdict/,
    );
  });

  it("declares every fixed renderer label in both locale tables and actually localizes Japanese labels", () => {
    const en = JSON.parse(fs.readFileSync(new URL("../../../src/locale/en/messages.json", import.meta.url), "utf8")).artifactView;
    const ja = JSON.parse(fs.readFileSync(new URL("../../../src/locale/ja/messages.json", import.meta.url), "utf8")).artifactView;
    for (const key of ARTIFACT_VIEW_LOCALIZATION_KEYS) {
      assert.equal(typeof en[key], "string", `missing English artifactView.${key}`);
      assert.equal(typeof ja[key], "string", `missing Japanese artifactView.${key}`);
    }
    const localized = new ArtifactViewLocalizer({ config: { lang: "ja" } });
    assert.equal(localized.message("testable"), "テスト可能");
    assert.equal(localized.message("question"), "質問");
    assert.equal(localized.message("cacheNotSaved"), "アーティファクトビューは生成されましたが、キャッシュを保存できませんでした。");
  });

  it("loads a project artifact-view locale override even without a preset type", () => {
    const projectRoot = root();
    const localeDirectory = path.join(projectRoot, ".sennel", "locale", "ja");
    fs.mkdirSync(localeDirectory, { recursive: true });
    fs.writeFileSync(path.join(localeDirectory, "messages.json"), JSON.stringify({
      artifactView: { titleSpec: "プロジェクト固有の仕様" },
    }));

    const localizer = new ArtifactViewLocalizer({ config: { lang: "ja" }, root: projectRoot });
    assert.equal(localizer.message("titleSpec"), "プロジェクト固有の仕様");
    assert.equal(localizer.message("purpose"), "目的");
  });

  it("declares the approval scene's regenerable legacy spec Markdown and leaves acceptance without a replacement", () => {
    const spec = FLOW_ARTIFACT_VIEW_REGISTRY.require("spec.record");
    const [replacement] = spec.legacyMarkdownReplacements;

    assert.equal(replacement.relativePath, "spec.md");
    assert.equal(replacement.scene, "approval");
    assert.equal(replacement.logicalKey, "spec.record");
    assert.equal(replacement.regenerationSource.logicalKey, "spec.record");
    assert.equal(replacement.regenerationSource.toJSON().verification, "catalog-verified");
    assert.equal(replacement.fullRange.includes("spec.purpose"), true);
    assert.equal(replacement.fullRange.includes("spec.task.T1"), true);
    assert.equal(replacement.fullRange.includes("acceptance.judgment.R1"), false);
    assert.deepEqual(FLOW_ARTIFACT_VIEW_REGISTRY.require("acceptance.review").legacyMarkdownReplacements, []);
  });
});
