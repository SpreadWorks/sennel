/** Read-only probe of an explicit copied Flow. No command/worker execution. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FlowManager } from "../src/lib/flow-manager.js";
import { readRetryBaseline, retryEvidenceRouteForNode } from "../src/flow/lib/retry-recovery.js";

const [root, specId] = process.argv.slice(2);
if (!root || !specId) throw new Error("Explicit isolated copy and specId required");
assert.equal(fs.existsSync(path.join(root, ".git")), false, "probe must not use a linked Git worktree");
const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
const state = manager.canonicalState(specId);
const route = retryEvidenceRouteForNode(state, state.attempt.nodeId);
const baseline = readRetryBaseline(manager, state, route);
process.stdout.write(`${JSON.stringify({
  runId: state.runId, specId: state.specId, issue: state.issue,
  current: state.current, attempt: state.attempt.toJSON(),
  failureDisposition: state.failureDisposition(), baseline: baseline?.toJSON() ?? null,
}, null, 2)}\n`);
// A regression expectation, intentionally red for the currently missing
// durable prerequisite. Do not fill or normalize the copied evidence.
assert.notEqual(baseline, null, "a recoverable failed Task Review must retain its parent-derived baseline");
