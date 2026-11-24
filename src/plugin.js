#!/usr/bin/env node

import fs from "fs";
import path from "node:path";
import { repoRoot, PKG_DIR } from "./lib/cli.js";
import { EXIT_ERROR } from "./lib/constants.js";
import { RuntimeChildExecution } from "./lib/runtime-package.js";
import { PRODUCT } from "./lib/product.js";
import {
  addPluginRepo,
  findPluginCandidates,
  installPlugin,
  listInstalledPlugins,
  maskPluginSource,
  planInstalledPluginUpdates,
  readProjectConfig,
  setPluginEnabled,
  syncInstalledPlugins,
  updateInstalledPlugin,
  updatePluginRepos,
} from "./lib/plugin-registry.js";

async function printHelp(root, command) {
  const { renderCommandHelp } = await import("./help.js");
  console.log(await renderCommandHelp({ root, command }));
}

function hasJson(args) {
  return args.includes("--json");
}

function hasNoUpgrade(args) {
  return args.includes("--no-upgrade");
}

function stripFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") continue;
    if (args[i] === "--no-upgrade") continue;
    if (args[i] === "--ref") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function refArg(args) {
  const index = args.indexOf("--ref");
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error("Missing value for --ref");
  return value;
}

function output(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) console.log(formatLine(item));
    return;
  }
  console.log(formatLine(value));
}

function upgradeSkip(reason) {
  return {
    ran: false,
    succeeded: false,
    ok: false,
    exitCode: null,
    skipReason: reason,
  };
}

function runAutomaticUpgrade(root) {
  const result = RuntimeChildExecution.runSync(path.join(PKG_DIR, PRODUCT.entrypointBasename), ["upgrade"], {
    cwd: root,
    env: {
      ...process.env,
      [PRODUCT.env("WORK_ROOT")]: root,
      [PRODUCT.env("SOURCE_ROOT")]: root,
    },
    maxBuffer: 50 * 1024 * 1024,
  });
  const upgrade = {
    ran: true,
    succeeded: result.ok,
    ok: result.ok,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    upgrade.error = `upgrade failed: ${detail}`;
  }
  return upgrade;
}

function upgradeResultLine(upgrade) {
  if (!upgrade.ran) return `upgrade skipped: ${upgrade.skipReason}`;
  if (upgrade.succeeded) return "upgrade ran";
  return `upgrade failed: ${upgrade.error}`;
}

function outputPluginOperationWithUpgrade(pluginResult, upgrade, { json, key, suppressItems = false }) {
  const value = key === "packages"
    ? { packages: pluginResult, upgrade }
    : { package: pluginResult, upgrade };
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    if (!suppressItems) output(pluginResult, false);
    console.log(upgradeResultLine(upgrade));
  }
  if (upgrade.ran && !upgrade.succeeded) process.exit(EXIT_ERROR);
}

export function renderPluginList(entries, { json = false } = {}) {
  const packages = entries.map((entry) => ({
    id: entry.id,
    source: typeof entry.source === "string" ? entry.source : entry.source?.id,
    commit: entry.commit,
    enabled: entry.enabled !== false,
  }));
  if (json) return JSON.stringify({ packages }, null, 2);
  return packages.map((entry) => `${entry.id} source=${entry.source} ${entry.commit || ""}`.trim()).join("\n");
}

export function renderPluginSourceMigrationGuide() {
  return [
    "Plugin source config migration:",
    "- Replace plugin.repos[] with plugin.sources[].",
    "- Replace plugin.packages[].repo with plugin.packages[].source.",
  ].join("\n");
}

function formatLine(value) {
  if (typeof value === "string") return value;
  if (value.id && value.status) return `${value.id} ${value.status} ${value.commit || ""}`.trim();
  if (value.id && value.source) return `${value.id} source=${typeof value.source === "string" ? maskPluginSource(value.source) : value.source.id} ${value.commit || ""}`.trim();
  return JSON.stringify(value);
}

function bulkUpdateAccepted(input) {
  const value = String(input || "").trim().toLowerCase();
  return value === "y" || value === "yes";
}

export function readPromptLine(fd = 0) {
  const bytes = [];
  const buffer = Buffer.alloc(1);
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, 1, null);
    if (bytesRead === 0) break;
    bytes.push(buffer[0]);
    if (buffer[0] === 10) break;
  }
  return Buffer.from(bytes).toString("utf8");
}

function promptBulkUpdate() {
  process.stderr.write("Update all installed plugins? [y/N] ");
  return bulkUpdateAccepted(readPromptLine());
}

function outputBulkUpdateCandidates(results, json) {
  if (json) {
    process.stderr.write(`${JSON.stringify({ packages: results }, null, 2)}\n`);
    return;
  }
  output(results, false);
}

function upgradeForUpdateResults(root, results, rest) {
  if (hasNoUpgrade(rest)) return upgradeSkip("no-upgrade option present");
  if (!results.some((result) => result.updated)) return upgradeSkip("no package updates");
  return runAutomaticUpgrade(root);
}

export async function main() {
  const root = repoRoot();
  const args = process.argv.slice(2);
  const [command, ...rest] = args;

  if (!command || command === "-h" || command === "--help") {
    await printHelp(root, ["plugin"]);
    return;
  }

  try {
    if (command === "repo") throw new Error(renderPluginSourceMigrationGuide());
    if (command === "source") {
      const [repoCommand, ...repoRest] = rest;
      if (!repoCommand || repoCommand === "-h" || repoCommand === "--help") {
        await printHelp(root, ["plugin", "source"]);
        return;
      }
      if (repoCommand === "add") {
        const source = stripFlags(repoRest)[0];
        if (!source) throw new Error("Usage: sennel plugin source add <git URL|local path>");
        output(addPluginRepo(root, source, refArg(repoRest)), false);
        return;
      }
      if (repoCommand === "update") {
        output(updatePluginRepos(root), hasJson(repoRest));
        return;
      }
      if (repoCommand === "list") {
        const config = readProjectConfig(root);
        output(config.plugin.sources, hasJson(repoRest));
        return;
      }
      throw new Error(`unknown plugin repo command: ${repoCommand}`);
    }

    if (command === "find") {
      output(findPluginCandidates(root), hasJson(rest));
      return;
    }
    if (command === "install") {
      const id = stripFlags(rest)[0];
      if (!id) throw new Error("Usage: sennel plugin install <id>");
      const result = installPlugin(root, id);
      if (!result?.id) throw new Error(`plugin install failed: ${id}`);
      const upgrade = hasNoUpgrade(rest)
        ? upgradeSkip("no-upgrade option present")
        : runAutomaticUpgrade(root);
      outputPluginOperationWithUpgrade(result, upgrade, { json: hasJson(rest), key: "package" });
      return;
    }
    if (command === "list") {
      output(listInstalledPlugins(root), hasJson(rest));
      return;
    }
    if (command === "enable" || command === "disable") {
      const id = stripFlags(rest)[0];
      if (!id) throw new Error(`Usage: sennel plugin ${command} <id>`);
      output(setPluginEnabled(root, id, command === "enable"), false);
      return;
    }
    if (command === "sync") {
      output(syncInstalledPlugins(root), hasJson(rest));
      return;
    }
    if (command === "update") {
      if (rest.includes("-h") || rest.includes("--help")) {
        await printHelp(root, ["plugin", "update"]);
        return;
      }
      const id = stripFlags(rest)[0];
      if (id) {
        const result = updateInstalledPlugin(root, id);
        const upgrade = upgradeForUpdateResults(root, [result], rest);
        outputPluginOperationWithUpgrade(result, upgrade, { json: hasJson(rest), key: "package" });
        return;
      }

      const plan = planInstalledPluginUpdates(root);
      const plannedResults = plan.toResults();
      if (!plan.hasUpdates) {
        outputPluginOperationWithUpgrade(plannedResults, upgradeSkip("no package updates"), {
          json: hasJson(rest),
          key: "packages",
        });
        return;
      }

      outputBulkUpdateCandidates(plannedResults, hasJson(rest));
      if (!promptBulkUpdate()) {
        outputPluginOperationWithUpgrade(plannedResults, upgradeSkip("update declined"), {
          json: hasJson(rest),
          key: "packages",
          suppressItems: true,
        });
        return;
      }

      const results = plan.apply(root);
      const upgrade = upgradeForUpdateResults(root, results, rest);
      outputPluginOperationWithUpgrade(results, upgrade, {
        json: hasJson(rest),
        key: "packages",
        suppressItems: true,
      });
      return;
    }

    throw new Error(`unknown plugin command: ${command}`);
  } catch (err) {
    console.error(maskPluginSource(err.message || String(err)));
    process.exit(EXIT_ERROR);
  }
}
