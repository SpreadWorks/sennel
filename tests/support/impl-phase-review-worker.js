/** External Review process fixture: production protocol/parser/seal, fake provider only. */
import fs from "node:fs";
import path from "node:path";
import { container } from "../../src/lib/container.js";
import { ReviewTextPromptPlan } from "../../src/flow/lib/review-text-prompt-plan.js";
import { PromptBatchExecutor } from "../../src/lib/prompt-batching.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { ReviewWorkUnit } from "../../src/flow/lib/review-work-unit.js";
import { TaskReviewExecutionIdentity } from "../../src/flow/lib/task-review-execution-identity.js";
import { runTaskReviewProtocol, parseImplReviewFindings, formatImplReviewJson, classifyReviewCommandError } from "../../src/flow/commands/review.js";
try {
const root = process.cwd();
container.register("root", root);
const work = ReviewWorkUnit.fromEnvironment(process.env);
const spec = JSON.parse(fs.readFileSync(JSON.parse(process.env.SENNEL_REVIEW_SPEC_SOURCE).sourcePath, "utf8"));
const requirementIds = new Set(spec.requirements.map((entry) => entry.id));
let raw = process.env.SENNEL_IMPL_SCENARIO_RESPONSE;
if (process.env.SENNEL_IMPL_SCENARIO_FILE_FAILURE) {
  const source = fs.readFileSync(JSON.parse(process.env.SENNEL_REVIEW_TASK_CURRENT_SOURCE).sourcePath, "utf8");
  const plan = ReviewTextPromptPlan.create({ request: { userPrompt: source, systemPrompt: "Review the complete immutable source." },
    maxChars: 6000, projectRoot: root });
  try {
    if (plan.fileInput === null) throw new Error("file-failure scenario requires actual complete file delivery");
    const parse = (response) => parseImplReviewFindings(response, { requirementIds });
    await new PromptBatchExecutor().executeCompletions({ plan: plan.corePlan, protocolPolicy: plan.protocolPolicy(parse),
      callAgent: () => raw, responseContract: { parse, itemCount: (value) => value.blockingFindings.length } });
  } finally { plan.dispose(); }
}
if (process.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY) {
  const source = JSON.parse(fs.readFileSync(JSON.parse(process.env.SENNEL_REVIEW_TASK_CURRENT_SOURCE).sourcePath, "utf8"));
  raw = await runTaskReviewProtocol({ root, flowManager: new FlowManager({ root, mainRoot: root, inWorktree: false }),
    executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(process.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
    requirementIds, recurrenceHistory: [], sourcePaths: new Set(source.entries.map((entry) => entry.path)),
    agent: { providerRetryPolicy: () => ({ retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }), async call() { return raw; } },
    prompt: "Review complete immutable source.", systemPrompt: "Return findings only.",
  });
}
const parsed = parseImplReviewFindings(raw, { requirementIds });
fs.writeFileSync(path.join(process.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), formatImplReviewJson({ ...parsed, requirementIds }));
work.seal();

} catch (error) {
  const failure = classifyReviewCommandError(error, "impl");
  process.stderr.write(failure === null ? error.stack : failure.toMarkerLine());
  process.exitCode = 1;
}
