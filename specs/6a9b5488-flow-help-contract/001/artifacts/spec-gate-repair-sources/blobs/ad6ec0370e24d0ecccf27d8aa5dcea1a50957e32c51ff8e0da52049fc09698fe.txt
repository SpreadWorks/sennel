import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { FLOW_QUERY_LIMITS } from "../../../src/flow/query-contract.js";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../infrastructure/flow-setup.js";
import { captureGitSnapshot } from "../../../src/lib/git-helpers.js";
import {
  FlowArtifactCatalog,
  FlowVersion,
  FlowVersionAuthorityScope,
  FlowVersionLocation,
} from "../../../src/lib/flow-version.js";
import { createTmpDir } from "./tmp-dir.js";
import { commitAll, initGitRepo } from "../infrastructure/git-repo.js";

const QUERY_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/sennel.js");
const DIGEST = "sha256";

function codeUnitOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const DEFAULT_TASK = Object.freeze({
  id: "T-1",
  title: "Query contract task",
  goal: "Exercise lifecycle and Activity projection fixtures.",
  parent: null,
  origin: "plan",
  added_round: 0,
  status: "pending",
});

function sha256(bytes) {
  return crypto.createHash(DIGEST).update(bytes).digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function versionLocation(root, specId, version) {
  return new FlowVersionLocation({
    repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(),
    specRoot: "specs",
    specId,
    version: new FlowVersion(version),
  });
}

function legacySteps(current = "branch") {
  const root = buildCurrentFlowDefinition().materializeRoot().toJSON();
  const convert = (node) => ({
    id: node.id,
    status: node.id === current || node.id === "plan" ? "in_progress" : "pending",
    steps: node.steps.map(convert),
  });
  return root.steps.map(convert);
}

/**
 * Build a real migration input, then let the production migration boundary
 * create the historical canonical Version. Query never consumes this layout.
 */
function migrateLegacyVersion(root, specId) {
  const legacyDirectory = path.join(root, "specs", specId);
  writeJson(path.join(legacyDirectory, "flow.json"), {
    spec: `specs/${specId}/spec.json`,
    request: "Read a historical Flow without trusted creation evidence.",
    steps: legacySteps(),
    tasks: [],
    currentTaskId: "branch",
  });
  writeJson(path.join(legacyDirectory, "spec.json"), {
    title: "Migrated query contract fixture",
    tasks: [],
  });

  const result = spawnSync(process.execPath, [QUERY_CLI, "migrate", "specs", "--to", "2"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
  if (result.status !== 0) {
    throw new Error(`migrated query fixture could not be materialized: ${result.stderr || result.stdout}`);
  }
}

function copyVersionTree(source, target) {
  fs.cpSync(source, target, { recursive: true, errorOnExist: true });
}

function materializeVersionedCopy(root, specId, sourceVersion, targetVersion) {
  const source = versionLocation(root, specId, sourceVersion);
  const target = versionLocation(root, specId, targetVersion);
  copyVersionTree(source.directory, target.directory);
  const state = JSON.parse(fs.readFileSync(source.flowStateFile, "utf8"));
  const spec = JSON.parse(fs.readFileSync(source.specFile, "utf8"));
  writeJson(target.flowStateFile, {
    recordRevision: 1,
    specId,
    flowVersion: targetVersion,
    state: { ...state, flowVersion: targetVersion },
  });
  writeJson(target.specFile, { recordRevision: 1, specId, content: spec });
  const catalogValue = JSON.parse(fs.readFileSync(target.catalogFile, "utf8"));
  const refreshedArtifacts = catalogValue.artifacts.map((artifact) => {
    if (!["flow.json", "spec.json"].includes(artifact.relativePath)) return artifact;
    const bytes = fs.readFileSync(target.resolve(artifact.relativePath));
    return { ...artifact, hash: sha256(bytes), size: bytes.length };
  });
  writeJson(target.catalogFile, new FlowArtifactCatalog({ artifacts: refreshedArtifacts }).toJSON());
  return target;
}

function failUntilBlocked(flowManager, specId) {
  const fail = () => flowManager.failCurrentAttempt({
    specId,
    failure: {
      category: "tooling",
      retryKind: "tooling",
      retryable: true,
      code: "QUERY_FIXTURE_PROVIDER_UNAVAILABLE",
      message: "Deterministic query fixture failure.",
    },
  });
  fail();
  for (let count = 0; flowManager.canonicalState(specId).failureDisposition().operation === "retry"; count += 1) {
    if (count >= 10) throw new Error("query blocked fixture exceeded its retry bound");
    flowManager.retryCurrentAttempt({ specId });
    fail();
  }
}

function settleAll(flow) {
  for (const step of flow.leaves()) flow.settle(step.id);
}

function gitStatus(root) {
  try {
    return execFileSync("git", ["status", "--short", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function snapshotTree(root) {
  const entries = [];
  const observedPaths = new Set();
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => codeUnitOrder(left.name, right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      observedPaths.add(relative);
      if (entry.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: fs.readlinkSync(absolute) });
      } else if (entry.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        visit(absolute);
      } else {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: relative, type: "file", size: bytes.length, digest: sha256(bytes) });
      }
    }
  };
  const snapshotDirectories = [
    path.join(root, "specs"),
    path.join(root, ".sennel"),
    path.join(root, ".tmp"),
    path.join(root, ".cache"),
    path.join(root, "cache"),
  ];
  for (const directory of snapshotDirectories) visit(directory);

  // Runtime state is intentionally outside the catalog authority, so keep an
  // explicit bounded inventory for every canonical Version. Missing markers
  // are important: a query creating a new lock/cache directory must change
  // the before/after snapshot just as surely as a query changing its bytes.
  const transientDirectories = new Set([
    ".runtime",
    ".runtime/locks",
    ".runtime/step-metadata",
    ".runtime/review-work-units",
    ".runtime/impl",
    ".runtime/retry-recovery",
    ".runtime/test-execute",
    ".runtime/finalize-cleanup",
  ]);
  const specRoot = path.join(root, "specs");
  if (fs.existsSync(specRoot)) {
    for (const specEntry of fs.readdirSync(specRoot, { withFileTypes: true })) {
      if (!specEntry.isDirectory() || specEntry.isSymbolicLink()) continue;
      const specDirectory = path.join(specRoot, specEntry.name);
      for (const versionEntry of fs.readdirSync(specDirectory, { withFileTypes: true })) {
        if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink() || !/^[1-9][0-9]*$/.test(versionEntry.name)) continue;
        for (const relative of transientDirectories) {
          const absolute = path.join(specDirectory, versionEntry.name, ...relative.split("/"));
          const repositoryPath = path.relative(root, absolute).split(path.sep).join("/");
          if (!observedPaths.has(repositoryPath) && !fs.existsSync(absolute)) {
            entries.push({ path: repositoryPath, type: "missing" });
          }
        }
      }
    }
  }
  for (const relative of [".sennel/agent-cache", ".cache", "cache"]) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!observedPaths.has(relative) && !fs.existsSync(absolute)) entries.push({ path: relative, type: "missing" });
  }
  entries.sort((left, right) => codeUnitOrder(left.path, right.path));
  return Object.freeze({
    digest: sha256(Buffer.from(JSON.stringify(entries), "utf8")),
    entries: Object.freeze(entries),
    gitStatus: gitStatus(root),
  });
}

class FlowQueryFixture {
  constructor({ root, specId, flowManager, flow, selectedVersion, locations, storage, lifecycle } = {}) {
    this.root = root;
    this.specId = specId;
    this.flowManager = flowManager;
    this.flow = flow;
    this.selectedVersion = selectedVersion;
    this.locations = locations;
    this.storage = storage;
    this.lifecycle = lifecycle;
    this.env = { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root };
    Object.freeze(this);
  }

  request(resource = "metadata", overrides = {}) {
    return {
      resource,
      condition: { specId: this.specId, ...(this.selectedVersion === 1 ? {} : { flowVersion: this.selectedVersion }) },
      ...(resource === "activities" ? { page: { limit: FLOW_QUERY_LIMITS.MAX_PAGE_LIMIT, after: null } } : {}),
      ...overrides,
    };
  }

  snapshot() { return snapshotTree(this.root); }
}

/**
 * Canonical query contract fixture matrix.
 *
 * `storage: "fresh"` uses the normal Version-1 Store writer. `storage:
 * "migrated"` uses the production specs migration boundary and adds a
 * VersionedCanonicalFlowRecords revision-1 copy so both authorities share
 * the same reader fixture. All returned roots are caller-owned.
 */
export function createFlowQueryFixture({
  storage = "fresh",
  lifecycle = "active",
  git = false,
  specId = "001-query-fixture",
  selectedVersion = storage === "migrated" ? 2 : 1,
} = {}) {
  if (!new Set(["fresh", "migrated"]).has(storage)) throw new TypeError(`unknown query fixture storage: ${storage}`);
  if (!new Set(["active", "parked", "blocked", "finalized"]).has(lifecycle)) {
    throw new TypeError(`unknown query fixture lifecycle: ${lifecycle}`);
  }
  if (storage === "migrated" && lifecycle !== "active") {
    throw new TypeError("migrated query fixture currently models the active historical lifecycle");
  }
  if (storage === "migrated" && git) throw new TypeError("migrated query fixture does not synthesize a Git snapshot");

  const root = createTmpDir("flow-query-fixture-");
  setupFlowConfig(root, "en");
  if (git) {
    initGitRepo(root);
    commitAll(root, "query fixture baseline");
  }

  if (storage === "migrated") {
    migrateLegacyVersion(root, specId);
    const versionOne = versionLocation(root, specId, 1);
    const versionTwo = materializeVersionedCopy(root, specId, 1, 2);
    if (![1, 2].includes(selectedVersion)) throw new TypeError("migrated query fixture supports Version 1 or 2");
    return new FlowQueryFixture({
      root,
      specId,
      flowManager: null,
      flow: null,
      selectedVersion,
      locations: { 1: versionOne, 2: versionTwo },
      storage,
      lifecycle,
    });
  }

  const flowManager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId: `run-${specId}`,
    context: git ? { gitSnapshot: captureGitSnapshot(root) } : null,
    specRecord: {
      goal: "Exercise the canonical Flow query contract.",
      capabilities: { query: true, fixture: true },
      ...(lifecycle === "blocked" ? {
        requirements: [{ id: "R-1", desc: "Exercise the query fixture Task.", task_ids: [DEFAULT_TASK.id] }],
      } : {}),
    },
  }).create();
  if (lifecycle === "blocked") flow.addTask({ ...DEFAULT_TASK });
  flow.registerActive();
  if (lifecycle === "blocked") {
    flow.activateTask(DEFAULT_TASK.id);
    failUntilBlocked(flowManager, specId);
  } else if (lifecycle === "parked") {
    flowManager.parkFlow(specId);
  } else if (lifecycle === "finalized") {
    settleAll(flow);
    flowManager.finalizeFlow(specId);
  }

  const versionOne = flow.location();
  const locations = { 1: versionOne };
  if (selectedVersion !== 1) locations[selectedVersion] = materializeVersionedCopy(root, specId, 1, selectedVersion);
  return new FlowQueryFixture({
    root,
    specId,
    flowManager,
    flow,
    selectedVersion,
    locations,
    storage,
    lifecycle,
  });
}

export function queryFixtureLimits() {
  return FLOW_QUERY_LIMITS;
}
