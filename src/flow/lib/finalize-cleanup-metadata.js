import crypto from "node:crypto";
import { CanonicalFlowArtifactWrite } from "./current-flow-state.js";
import { issueLogStoreForVersion } from "./set-issue-log.js";

export function recordFinalizeCleanupPostCommandMetadata({
  flowManager,
  specId,
  metrics = [],
  runtimeLog = null,
  notes = [],
  issueLogEntries = [],
  pluginArtifacts = [],
  report = null,
  recoveryEnvelope = null,
  operationOwnerToken = null,
} = {}) {
  if (!flowManager) throw new Error("flowManager is required");
  const specLocation = flowManager.specLocation(specId);
  const writtenPaths = [];
  const surfaces = new Set();
  const callerVisible = {};

  function appendCatalogedEntries(logicalKey, key, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    let existing = [];
    try {
      const artifact = flowManager.readArtifact({
        specId,
        logicalKey,
        consumerNodeId: "finalize-cleanup",
        optional: true,
      });
      if (artifact !== null) {
        const current = JSON.parse(artifact.bytes.toString("utf8"));
        if (Array.isArray(current?.[key])) existing = current[key];
      }
    } catch (error) {
      throw new Error(`canonical finalize-cleanup ${logicalKey} is invalid: ${error.message}`, { cause: error });
    }
    return new CanonicalFlowArtifactWrite({
      logicalKey,
      mediaType: "application/json",
      bytes: `${JSON.stringify({ version: 1, [key]: [...existing, ...entries] }, null, 2)}\n`,
    });
  }

  const artifactWrites = [
    appendCatalogedEntries("finalize.cleanup.agent-metrics", "entries", metrics),
    appendCatalogedEntries("finalize.cleanup.notes", "entries", notes),
    appendCatalogedEntries("finalize.cleanup.plugin-artifacts", "artifacts", pluginArtifacts),
  ].filter(Boolean);
  if (artifactWrites.length > 0) {
    flowManager.publishArtifacts({
      specId,
      nodeId: "finalize-cleanup",
      artifactWrites,
    });
    for (const write of artifactWrites) writtenPaths.push(specLocation.resolve(write.artifact.relativePath));
    if (metrics.length > 0) surfaces.add("agent-metrics");
    if (notes.length > 0) surfaces.add("notes");
  }
  if (runtimeLog) {
    flowManager.writeRuntimeArtifact({
      specId,
      nodeId: "finalize-cleanup",
      artifact: {
        logicalKey: "finalize.cleanup.runtime-log",
        mediaType: "application/json",
        bytes: `${JSON.stringify({ version: 1, runtimeLog }, null, 2)}\n`,
      },
    });
    surfaces.add("runtime-log");
  }
  if (issueLogEntries.length > 0) {
    const timestamp = new Date().toISOString();
    issueLogStoreForVersion(specLocation, { operationOwnerToken }).appendMany(issueLogEntries.map((entry) => {
      const normalized = { ...entry, timestamp: entry?.timestamp || timestamp };
      const idempotencyKey = finalizeLifecycleIssueLogId(entry);
      return { entry: normalized, idempotencyKey };
    }));
    writtenPaths.push(specLocation.issueLogFile);
    surfaces.add("issue-log");
  }
  if (pluginArtifacts.length > 0) {
    callerVisible.plugin = {
      warnings: pluginArtifacts.flatMap((a) => a?.data?.warnings || []),
      followUps: pluginArtifacts.flatMap((a) => a?.data?.followUps || []),
      artifacts: pluginArtifacts,
    };
    surfaces.add("plugin-hook-output");
  }
  if (report) {
    // Envelopes are command-return values, not Flow evidence.  Keeping them
    // on disk created a second, non-catalog finalize authority.
    callerVisible.report = report;
  }
  if (recoveryEnvelope) {
    callerVisible.recoveryEnvelope = recoveryEnvelope;
  }

  return {
    writtenPaths,
    surfaces: [...surfaces],
    callerVisible,
  };
}

function finalizeLifecycleIssueLogId(entry) {
  return entry?.issueLogId || `finalize-cleanup-lifecycle-${crypto
    .createHash("sha256")
    .update(JSON.stringify(entry))
    .digest("hex")}`;
}
