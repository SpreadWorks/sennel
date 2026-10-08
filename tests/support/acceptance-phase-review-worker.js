/** Real Flow Review CLI/protocol/writer; only the external provider response is fake. */
import fs from "node:fs";
import { container } from "../../src/lib/container.js";
import { loadConfig } from "../../src/lib/config.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import FlowReviewCommand, { parseImplReviewFindings } from "../../src/flow/commands/review.js";
import { ReviewTextPromptPlan } from "../../src/flow/lib/review-text-prompt-plan.js";
import { PromptBatchExecutor } from "../../src/lib/prompt-batching.js";

const root = process.cwd();
container.register("root", root);
container.register("mainRoot", root);
container.register("config", loadConfig(root));
container.register("flowManager", new FlowManager({ root, mainRoot: root, inWorktree: false }));
const spec = JSON.parse(fs.readFileSync(JSON.parse(process.env.SENNEL_REVIEW_SPEC_SOURCE).sourcePath, "utf8"));
const requirementIds = new Set(spec.requirements.map((entry) => entry.id));
container.register("agent", {
  resolve() { return { providerKey: "fixture", profileKey: "fixture" }; },
  providerRetryPolicy() { return { retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }; },
  async call(prompt, options) {
    const plan = ReviewTextPromptPlan.create({ request: { userPrompt: prompt, systemPrompt: options.systemPrompt },
      maxChars: 6000, projectRoot: root });
    try {
      if (plan.fileInput === null) return options.jsonSchema
        ? JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }) : "NO_PROPOSALS";
      const parse = (raw) => parseImplReviewFindings(raw, { requirementIds });
      await new PromptBatchExecutor().executeCompletions({ plan: plan.corePlan, protocolPolicy: plan.protocolPolicy(parse),
        callAgent: () => JSON.stringify({ evaluationUnavailable: { kind: "file-read-failed",
          reason: "The external reviewer could not read the complete current source." } }),
        responseContract: { parse, itemCount: (value) => value.blockingFindings.length } });
      throw new Error("the file-read failure must exhaust the real bounded protocol");
    } finally { plan.dispose(); }
  },
});

await new FlowReviewCommand().execute({ _rawArgs: process.argv.slice(2) });
