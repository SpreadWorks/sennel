/**
 * tests/integration/flow/run-report-show.test.js
 *
 * Covers AC1/AC2/AC3 of spec 211: `sennel flow report show` streams the
 * latest finalize Report text from `report.json`, and fails clearly when the
 * pointer or `report.json` is missing.
 */

import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createTmpDir, removeTmpDir, writeFile } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { FlowAtStepFixture, makeFlowManager, produceCanonicalFixtureStep } from "../../support/infrastructure/flow-setup.js";
import {
  CanonicalLatestReport,
  POINTER_REL_PATH,
} from "../../../src/flow/lib/run-report-show.js";

const SPEC_ID = "001-demo";

async function canonicalReportFixture(root, { specRoot = "specs", produce = true } = {}) {
  initGitRepo(root);
  writeFile(root, "README.md", "Canonical report display fixture.\n");
  commitAll(root, "initial report fixture");
  const flowManager = makeFlowManager(root, { specRoot });
  const fixture = await new FlowAtStepFixture({
    flowManager, specId: SPEC_ID, runId: "run-report-show",
    request: "Render the finalized canonical report.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: { requirements: [{ id: "R-report", desc: "Render the finalized report.", testable: false }] },
    targetStep: "report",
  }).createWithProducers();
  const flow = fixture.flow.flow;
  if (produce) await flow.produce("report");
  writeFile(root, POINTER_REL_PATH, `${flow.specId}\n`);
  return { flow, flowManager };
}

class CanonicalReportScenario {
  constructor(workRoot, flowManager, parserInput) {
    this.workRoot = workRoot;
    this.flowManager = flowManager;
    this.location = flowManager.specLocation(SPEC_ID);
    this.parserInput = parserInput;
  }

  read() {
    return CanonicalLatestReport.read({ mainRoot: this.workRoot.root, specRoot: "specs", flowManager: this.flowManager });
  }

  parser() {
    const actual = this.read();
    return new CanonicalLatestReport({ specId: actual.specId, relativePath: actual.relativePath,
      path: actual.path, bytes: Buffer.isBuffer(this.parserInput) ? this.parserInput
        : Buffer.from(`${JSON.stringify(this.parserInput)}\n`, "utf8") });
  }

  cleanup() { this.workRoot.cleanup(); }
}

class CanonicalReportSeed {
  constructor() { this.root = createTmpDir("sennel-report-seed-"); }

  async initialize() {
    await canonicalReportFixture(this.root, { produce: false });
    return this;
  }

  async createScenario(report) {
    const workRoot = new SeedWorkRoot(this.root, { prefix: "sennel-report-show-" });
    const flowManager = makeFlowManager(workRoot.root);
    if (report !== null) {
      await produceCanonicalFixtureStep({ root: workRoot.root, mainRoot: workRoot.root, executionRoot: workRoot.root,
        specId: SPEC_ID, flowManager, flowState: flowManager.loadReadOnly(SPEC_ID), config: {} }, "report");
    }
    return new CanonicalReportScenario(workRoot, flowManager, report);
  }

  cleanup() { removeTmpDir(this.root); }
}

describe("flow report show — resolve + read", () => {
  let tmp;
  let seed;
  let scenario;

  before(async () => { seed = new CanonicalReportSeed(); await seed.initialize(); });
  after(() => seed.cleanup());
  afterEach(() => {
    if (scenario) scenario.cleanup();
    if (tmp) removeTmpDir(tmp);
    scenario = null;
    tmp = null;
  });

  it("AC1: resolves latest report.json from pointer and returns its text field", async () => {
    const reportText = "  Report\n\n  Implementation\n──\n    feat: demo\n";
    scenario = await seed.createScenario({ data: {}, text: reportText });

    const generated = scenario.read();
    assert.equal(generated.text(), JSON.parse(fs.readFileSync(generated.path, "utf8")).text);
    const report = scenario.parser();
    assert.equal(
      report.path,
      path.join(scenario.location.directory, "artifacts/report.json"),
    );
    assert.equal(report.text(), reportText);
  });

  it("resolves a report from a configured spec root", async () => {
    tmp = createTmpDir("sennel-report-show-configured-root-");
    const { flow, flowManager } = await canonicalReportFixture(tmp, {
      specRoot: "flow-artifacts/specs",
    });

    const report = CanonicalLatestReport.read({
      mainRoot: tmp,
      specRoot: "flow-artifacts/specs",
      flowManager,
    });
    assert.equal(report.path, path.join(flow.location().directory, "artifacts/report.json"));
  });

  it("AC2: throws NO_POINTER when the pointer file is absent", () => {
    tmp = createTmpDir("sennel-report-show-no-ptr-");
    assert.throws(
      () => CanonicalLatestReport.read({ mainRoot: tmp }),
      (err) => err.code === "NO_POINTER" && /pointer not found/.test(err.message),
    );
  });

  it("AC2: throws EMPTY_POINTER when the pointer file is empty", () => {
    tmp = createTmpDir("sennel-report-show-empty-ptr-");
    writeFile(tmp, POINTER_REL_PATH, "   \n");
    assert.throws(
      () => CanonicalLatestReport.read({ mainRoot: tmp }),
      (err) => err.code === "EMPTY_POINTER",
    );
  });

  it("AC3: throws NO_REPORT when pointer exists but report.json is missing", async () => {
    scenario = await seed.createScenario(null);
    assert.throws(
      () => CanonicalLatestReport.read({
        mainRoot: scenario.workRoot.root,
        specRoot: "specs",
        flowManager: scenario.flowManager,
      }),
      (err) => err.code === "NO_REPORT" && /cataloged report is unavailable/.test(err.message),
    );
  });

  it("throws PARSE_ERROR when supplied parser-boundary bytes are invalid JSON", async () => {
    scenario = await seed.createScenario(Buffer.from("{ not json"));
    const report = scenario.parser();
    assert.throws(
      () => report.text(),
      (err) => err.code === "PARSE_ERROR",
    );
  });

  it("throws NO_TEXT when supplied parser-boundary bytes have no text field", async () => {
    scenario = await seed.createScenario({ data: {} });
    const report = scenario.parser();
    assert.throws(
      () => report.text(),
      (err) => err.code === "NO_TEXT",
    );
  });
});
