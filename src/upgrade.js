#!/usr/bin/env node
/**
 * sennel/upgrade.js
 *
 * Upgrade skill-derived files (skills, AGENTS.md Spec-Driven Development section) to match
 * the currently installed sennel version.
 *
 * Safe to run repeatedly — only overwrites skill-managed content. config.json
 * is validated but never rewritten by a normal upgrade. context.json is
 * untouched. Project migrations are independent public commands and are not
 * part of normal package-managed upgrades.
 *
 * Usage:
 *   sennel upgrade [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { repoRoot, parseArgs } from "./lib/cli.js";
import { EXIT_ERROR } from "./lib/constants.js";
import { DEFAULT_LANG, loadConfig } from "./lib/config.js";
import { container } from "./lib/container.js";
import { translate } from "./lib/i18n.js";
import { validatePresetChain } from "./lib/presets.js";
import { enabledPluginSkillSourceDirs } from "./lib/plugin-registry.js";
import {
  deploySkills,
  deploySkillsFromDir,
  cleanupObsoleteSkills,
  MAIN_SKILLS_DIR,
} from "./lib/skills.js";
import { deployPresetCopies } from "./lib/preset-deploy.js";
import { createUpgradeResultArtifact } from "./flow/lib/test-artifacts.js";
import {
  AGENT_CONFIG_FILE_NAMES,
  refreshAgentFlowFile,
} from "./lib/agent-config-files.js";
import { removeLegacyAgentArtifacts } from "./lib/legacy-agent-artifact-cleanup.js";
import { FlowHandoffAuthorityLease } from "./lib/flow-handoff-authority-lease.js";
import {
  WORKER_ARTIFACT_HANDOFF_REQUEST_ENV,
  WorkerArtifactHandoffError,
  assertWorkerUpgradeAllowed,
  stageWorkerUpgradeResult,
} from "./flow/lib/worker-artifact-handoff.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseUpgradeArgs(argv) {
  return parseArgs(argv, {
    flags: ["--dry-run"],
    options: [],
    defaults: { dryRun: false },
  });
}

export function activeFlowExecutionRoot({ state, flowManager, mainRoot } = {}) {
  if (state?.execution?.mode === "worktree") {
    return flowManager.resolveWorktreePaths(state).worktreePath;
  }
  return mainRoot;
}

function realRepositoryPath(root, label) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(`${label} requires a repository root`);
  }
  try {
    return fs.realpathSync(path.resolve(root));
  } catch (cause) {
    throw new Error(`${label} requires a real repository root: ${cause.message}`);
  }
}

export function activeUpgradeRootMatches({ root, state, flowManager, mainRoot } = {}) {
  const executionRoot = activeFlowExecutionRoot({ state, flowManager, mainRoot });
  return realRepositoryPath(root, "active Flow upgrade root")
    === realRepositoryPath(executionRoot, "active Flow execution root");
}

const FLOW_EXECUTION_MODES = new Set(["direct", "branch", "worktree"]);

class ActiveUpgradeFlow {
  constructor({ state, flowManager, mainRoot, executionRoot }) {
    if (
      state?.schemaRevision !== 3
      || !state.specId
      || !state.runId
      || !state.baseBranch
      || !FLOW_EXECUTION_MODES.has(state.execution?.mode)
    ) {
      throw new Error("active Flow upgrade requires a complete Version-1 Flow state");
    }
    if (typeof mainRoot !== "string" || mainRoot.trim() === "") {
      throw new Error("active Flow upgrade requires a canonical main repository root");
    }
    if (typeof executionRoot !== "string" || executionRoot.trim() === "") {
      throw new Error("active Flow upgrade requires an execution repository root");
    }
    this.state = state;
    this.flowManager = flowManager;
    this.mainRoot = realRepositoryPath(mainRoot, "active Flow canonical main repository root");
    this.executionRoot = realRepositoryPath(executionRoot, "active Flow execution repository root");
    Object.freeze(this);
  }

  matchesRoot(root) {
    return realRepositoryPath(root, "active Flow upgrade root") === this.executionRoot;
  }

  matchesWorker(request) {
    return this.state.specId === request.specId && this.state.runId === request.runId;
  }

  createResultArtifact({ root, command, dryRun, exitCode, result, summary }) {
    return createUpgradeResultArtifact({
      root,
      baseBranch: this.state.baseBranch,
      command,
      dryRun,
      exitCode,
      result,
      summary,
    });
  }

  publishResult(artifact) {
    this.flowManager.publishUpgradeResult({
      specId: this.state.specId,
      artifact: {
        logicalKey: "upgrade.result",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(artifact.toJSON(), null, 2)}\n`, "utf8"),
      },
    });
  }

  assertWritable() {
    if (typeof this.flowManager.assertFlowStateWritable !== "function") {
      throw new Error("active Flow upgrade requires a canonical Flow writability assertion");
    }
    return this.flowManager.assertFlowStateWritable(this.state.specId);
  }
}

export class ActiveUpgradeFlowCollection {
  constructor(flows = []) {
    if (!Array.isArray(flows) || flows.some((flow) => !(flow instanceof ActiveUpgradeFlow))) {
      throw new Error("active upgrade flows must be typed Flow upgrade contexts");
    }
    const specIds = new Set();
    for (const flow of flows) {
      if (specIds.has(flow.state.specId)) throw new Error("active upgrade flows contain duplicate specIds");
      specIds.add(flow.state.specId);
    }
    this.flows = Object.freeze([...flows]);
    Object.freeze(this);
  }

  static empty() {
    return new ActiveUpgradeFlowCollection();
  }

  get isEmpty() {
    return this.flows.length === 0;
  }

  forWorker(request) {
    return this.flows.find((flow) => flow.matchesWorker(request)) ?? null;
  }

  assertWritable() {
    for (const flow of this.flows) flow.assertWritable();
  }

  publishResults(input) {
    const publications = this.flows.map((flow) => Object.freeze({
      flow,
      artifact: flow.createResultArtifact(input),
    }));
    this.assertWritable();
    for (const { flow, artifact } of publications) flow.publishResult(artifact);
  }
}

export function resolveActiveUpgradeFlows(root) {
  if (!container.has("flowManager")) return ActiveUpgradeFlowCollection.empty();
  const flowManager = container.get("flowManager");
  if (typeof flowManager.loadActiveFlows !== "function" || typeof flowManager.forRoot !== "function") {
    throw new Error("active Flow upgrade requires the canonical active Flow registry");
  }
  const entries = flowManager.loadActiveFlows();
  if (!Array.isArray(entries)) throw new Error("active Flow registry must return an array");
  if (entries.length === 0) return ActiveUpgradeFlowCollection.empty();
  const mainRoot = realRepositoryPath(
    container.has("mainRoot") ? container.get("mainRoot") : null,
    "active Flow canonical main repository root",
  );
  const matches = [];
  for (const entry of entries) {
    if (typeof entry?.specId !== "string" || entry.specId === "") {
      throw new Error("active Flow registry entry requires a specId");
    }
    // A worktree-bound manager must not load an unrelated spec through its
    // execution binding. Enumerate every active state from the main-root
    // authority, and retain that canonical manager for eventual publication.
    const canonicalFlowManager = flowManager.forRoot(mainRoot, { specId: entry.specId });
    const state = canonicalFlowManager.load(entry.specId);
    if (state === null) throw new Error(`active Flow state is missing for ${entry.specId}`);
    const executionRoot = activeFlowExecutionRoot({ state, flowManager: canonicalFlowManager, mainRoot });
    const activeFlow = new ActiveUpgradeFlow({ state, flowManager: canonicalFlowManager, mainRoot, executionRoot });
    // An upgrade only certifies the checkout it actually updated. A main-root
    // invocation during a worktree Flow remains useful, but cannot satisfy
    // that Flow's upgrade evidence gate or contend for its handoff lease.
    if (activeFlow.matchesRoot(root)) matches.push(activeFlow);
  }
  return new ActiveUpgradeFlowCollection(matches);
}

function activeUpgradeFlowForWorker(request, root) {
  const activeFlows = resolveActiveUpgradeFlows(root);
  const activeFlow = activeFlows.forWorker(request);
  if (activeFlow === null) {
    throw new WorkerArtifactHandoffError(
      "stale",
      "FLOW_WORKER_UPGRADE_ACTIVE_FLOW_MISMATCH",
      "worker upgrade handoff does not match the canonical active Flow",
      {
        retryable: false,
        data: {
          handoffSpecId: request.specId,
          handoffRunId: request.runId,
          activeSpecId: activeFlow?.state.specId ?? null,
          activeRunId: activeFlow?.state.runId ?? null,
        },
      },
    );
  }
  return new ActiveUpgradeFlowCollection([activeFlow]);
}

function createUpgradeLogger() {
  return {
    log(message = "") {
      const text = String(message);
      console.log(text);
    },
    error(message = "") {
      const text = String(message);
      console.error(text);
    },
  };
}

function resultFromSummary(exitCode, hasChanges) {
  if (exitCode !== 0) return "failed";
  return hasChanges ? "success-updated" : "success-no-change";
}

export function writeActiveUpgradeArtifact({ root, activeFlows, workerHandoffRequest = null, command, dryRun, exitCode, result, summary }) {
  if (dryRun) return;
  if (!(activeFlows instanceof ActiveUpgradeFlowCollection)) {
    throw new Error("active upgrade artifact publication requires typed active Flow contexts");
  }
  if (workerHandoffRequest === null && activeFlows.isEmpty) return;
  if (workerHandoffRequest !== null) {
    if (activeFlows.flows.length !== 1) {
      throw new Error("worker upgrade artifact publication requires exactly one active Flow");
    }
    const [activeFlow] = activeFlows.flows;
    const artifact = activeFlow.createResultArtifact({ root, command, dryRun, exitCode, result, summary });
    stageWorkerUpgradeResult({ requestPath: workerHandoffRequest, artifact: artifact.toJSON() });
    return;
  }
  activeFlows.publishResults({ root, command, dryRun, exitCode, result, summary });
}

function printUpgradeHelp(logger) {
  const h = translate().raw("ui:help.cmdHelp.upgrade");
  const files = h.updatedFiles || [];
  logger.log([
    h.usage, "", `  ${h.desc}`, `  ${h.descDetail}`, "",
    "Updated files:",
    ...files.map((file) => `  ${file}`),
    "", "Options:", h.options.dryRun, h.options.help,
  ].join("\n"));
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runNormalUpgrade(cli) {
  const root = repoRoot();
  const dryRun = cli.dryRun;
  const logger = createUpgradeLogger();
  const workerHandoffRequest = process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV] ?? null;
  // Validate source authority before any materialized upgrade writes. An
  // artifact-only worker may run --dry-run, but cannot change its checkout.
  const workerHandoff = workerHandoffRequest === null
    ? null
    : assertWorkerUpgradeAllowed({ requestPath: workerHandoffRequest, dryRun: cli.dryRun });
  // A source worker must use the canonical Flow's base branch when computing
  // evidence, but never obtains its publication lease or writes the Version
  // Store. Artifact-only dry-runs do not produce a handoff payload.
  // An external materialized upgrade serializes against the checkout before
  // reading the active registry. Re-resolving only after this acquisition
  // closes the no-active → dispatcher-start race.
  const authorityLease = !dryRun && workerHandoffRequest === null
    ? new FlowHandoffAuthorityLease({
      mainRoot: container.has("mainRoot") ? container.get("mainRoot") : root,
      executionRoot: root,
    })
    : null;
  if (authorityLease !== null) {
    logger.log("[upgrade] waiting for checkout handoff authority when necessary");
    authorityLease.acquire();
  }
  try {
    const activeFlows = dryRun
      ? ActiveUpgradeFlowCollection.empty()
      : workerHandoffRequest === null
      ? resolveActiveUpgradeFlows(root)
      : workerHandoff === null
        ? ActiveUpgradeFlowCollection.empty()
        : activeUpgradeFlowForWorker(workerHandoff, root);
    // Reject a known-unwritable canonical target before modifying skill,
    // preset, or agent files. Publication performs the same preflight again
    // to close state changes that race with the upgrade work itself.
    if (workerHandoffRequest === null) activeFlows.assertWritable();
    const command = ["sennel", "upgrade", ...process.argv.slice(2)].join(" ");

    const summary = {
      skills: { updated: 0, unchanged: 0, removed: 0 },
      legacyAgentArtifacts: { removed: 0, unchanged: 0 },
      presets: { copied: 0 },
      agentFiles: { updated: 0, unchanged: 0, missing: 0 },
      config: { changed: false },
    };

    const config = loadConfig(root);
    const t = translate();
    // Fail-fast: chapters ↔ preset chain static integrity check (spec 218).
    if (config.type) {
      try {
        validatePresetChain(config.type, root, {
          languages: config.docs?.languages || [],
          configChapters: config.chapters,
        });
      } catch (e) {
        logger.error(e.message);
        writeActiveUpgradeArtifact({
          root,
          activeFlows,
          workerHandoffRequest: workerHandoff === null ? null : workerHandoffRequest,
          command,
          dryRun,
          exitCode: EXIT_ERROR,
          result: "failed",
          summary: { ...summary, error: e.message },
        });
        process.exitCode = EXIT_ERROR;
        return;
      }
    }

    if (dryRun) {
      logger.log(t("ui:upgrade.dryRunHeader"));
    }

    function logSkillResults(results) {
      for (const { name, status } of results) {
        if (status === "updated") {
          logger.log(t("ui:upgrade.skillUpdated", { name }));
        } else {
          logger.log(t("ui:upgrade.skillUnchanged", { name }));
        }
      }
    }

    // Plugins may add skills, but bundled product skills are the final authority
    // for a name collision.
    let skillResults = [];
    try {
      for (const skillsDir of enabledPluginSkillSourceDirs(root)) {
        skillResults.push(...deploySkillsFromDir({ skillsDir, workRoot: root, dryRun }));
      }
      // Bundled product skills win over plugins that declare a colliding name.
      skillResults.push(...deploySkills(root, { dryRun, force: true }));
    } catch (e) {
      logger.error(`upgrade failed: ${e.message}`);
      writeActiveUpgradeArtifact({
        root,
        activeFlows,
        workerHandoffRequest: workerHandoff === null ? null : workerHandoffRequest,
        command,
        dryRun,
        exitCode: EXIT_ERROR,
        result: "failed",
        summary: { ...summary, error: `upgrade failed: ${e.message}` },
      });
      process.exitCode = EXIT_ERROR;
      return;
    }
    logSkillResults(skillResults);
    summary.skills.updated = skillResults.filter((r) => r.status === "updated").length;
    summary.skills.unchanged = skillResults.filter((r) => r.status === "unchanged").length;

    // Remove obsolete canonical and explicitly retired product skill namespaces.
    const removedSkills = cleanupObsoleteSkills(root, [MAIN_SKILLS_DIR, ...enabledPluginSkillSourceDirs(root)], { dryRun });
    summary.skills.removed = removedSkills.length;
    for (const { name } of removedSkills) {
      logger.log(t("ui:upgrade.skillRemoved", { name }));
    }

    try {
      const cleanup = removeLegacyAgentArtifacts(root, { dryRun });
      const removed = Number(cleanup.removedHandler) + Number(cleanup.updatedConfig);
      if (removed > 0) {
        summary.legacyAgentArtifacts.removed += removed;
        logger.log("[upgrade] removed legacy agent-host Flow hook artifacts");
      } else {
        summary.legacyAgentArtifacts.unchanged += 1;
      }
    } catch (e) {
      logger.error(`upgrade failed: ${e.message}`);
      writeActiveUpgradeArtifact({
        root,
        activeFlows,
        workerHandoffRequest: workerHandoff === null ? null : workerHandoffRequest,
        command,
        dryRun,
        exitCode: EXIT_ERROR,
        result: "failed",
        summary: { ...summary, error: `legacy agent artifact cleanup failed: ${e.message}` },
      });
      process.exitCode = EXIT_ERROR;
      return;
    }

    if (!dryRun) {
      const presetCopies = deployPresetCopies(root, {
        presetKeys: ["base"],
        languages: config.docs?.languages?.length ? config.docs.languages : ["en", "ja"],
      });
      summary.presets.copied = presetCopies.length;
    }

    const agentFileResults = AGENT_CONFIG_FILE_NAMES.map((fileName) =>
      refreshAgentFlowFile(path.join(root, fileName), config.lang || DEFAULT_LANG, {
        dryRun,
        projectRoot: root,
        presetTypes: config.type || "base",
      }));
    for (const result of agentFileResults) {
      summary.agentFiles[result.status] += 1;
      if (result.status === "updated") {
        logger.log(t("ui:upgrade.agentFileUpdated", { file: result.file }));
      } else if (result.status === "unchanged") {
        logger.log(t("ui:upgrade.agentFileUnchanged", { file: result.file }));
      } else {
        logger.log(t("ui:upgrade.agentFileMissing", { file: result.file }));
      }
    }

    // Summary
    const hasChanges = skillResults.some((r) => r.status === "updated")
      || removedSkills.length > 0
      || summary.legacyAgentArtifacts.removed > 0
      || summary.agentFiles.updated > 0
      || summary.presets.copied > 0;
    if (!hasChanges) {
      logger.log(t("ui:upgrade.noChanges"));
    } else if (dryRun) {
      logger.log(t("ui:upgrade.dryRunFooter"));
    } else {
      logger.log(t("ui:upgrade.done"));
    }

    try {
      writeActiveUpgradeArtifact({
        root,
        activeFlows,
        workerHandoffRequest: workerHandoff === null ? null : workerHandoffRequest,
        command,
        dryRun,
        exitCode: 0,
        result: resultFromSummary(0, hasChanges),
        summary,
      });
    } catch (e) {
      logger.error(`upgrade artifact write failed: ${e.message}`);
      process.exitCode = EXIT_ERROR;
      return;
    }
  } finally {
    authorityLease?.release();
  }
}

async function main() {
  const cli = parseUpgradeArgs(process.argv.slice(2));
  if (cli.help) {
    printUpgradeHelp(createUpgradeLogger());
    return;
  }
  return runNormalUpgrade(cli);
}


export { main };
