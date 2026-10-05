/** Deterministic external Review process for the downstream phase scenario.
 * Uses the real Task provider protocol and work-unit seal; no canonical Review
 * artifact, receipt, decision or lifecycle transition is constructed here.
 */
import fs from "node:fs";
import path from "node:path";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { ReviewWorkUnit } from "../../src/flow/lib/review-work-unit.js";
import { TaskReviewExecutionIdentity } from "../../src/flow/lib/task-review-execution-identity.js";
import { runTaskReviewProtocol, parseImplReviewFindings, formatImplReviewJson } from "../../src/flow/commands/review.js";

const root = process.cwd();
const work = ReviewWorkUnit.fromEnvironment(process.env);
const source = JSON.parse(process.env.SENNEL_REVIEW_SPEC_SOURCE);
const spec = JSON.parse(fs.readFileSync(source.sourcePath, "utf8"));
const requirementIds = new Set(spec.requirements.map((entry) => entry.id));
let raw = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
if (process.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const currentSource = JSON.parse(process.env.SENNEL_REVIEW_TASK_CURRENT_SOURCE);
  const current = JSON.parse(fs.readFileSync(currentSource.sourcePath, "utf8"));
  raw = await runTaskReviewProtocol({ root, flowManager: manager,
    executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(process.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
    requirementIds, recurrenceHistory: [], sourcePaths: new Set(current.entries.map((entry) => entry.path)),
    agent: { providerRetryPolicy: () => ({ retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }), async call() { return raw; } },
    prompt: "Review the current implementation.", systemPrompt: "Return the complete Review response.",
  });
}
const parsed = parseImplReviewFindings(raw, { requirementIds });
fs.writeFileSync(path.join(process.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), formatImplReviewJson({ ...parsed, requirementIds }));
work.seal();
