/** Real Review child writer/protocol/seal; only the evaluator is unavailable. */
import { initContainer, container } from "../../../src/lib/container.js";
import FlowReviewCommand, { parseImplReviewFindings, classifyReviewCommandError } from "../../../src/flow/commands/review.js";
import { ReviewTextPromptPlan } from "../../../src/flow/lib/review-text-prompt-plan.js";
import { PromptBatchExecutor } from "../../../src/lib/prompt-batching.js";

try {
  initContainer();
  container.register("agent", { resolve: () => true,
    async call(prompt) {
      if (process.env.SENNEL_IMPL_SCENARIO_PLAIN_FAILURE === "true") {
        throw new Error("UNPARENTED_ORIGINAL_PROVIDER_FAILURE");
      }
      const plan = ReviewTextPromptPlan.create({ request: { userPrompt: prompt, systemPrompt: "Review the complete immutable input." },
        maxChars: 1600, projectRoot: process.cwd() });
      try {
        const parse = (raw) => parseImplReviewFindings(raw);
        return await new PromptBatchExecutor().executeCompletions({ plan: plan.corePlan,
          protocolPolicy: plan.protocolPolicy(parse),
          responseContract: { parse, itemCount: (response) => response.blockingFindings.length },
          callAgent: () => JSON.stringify(!plan.responseEnveloped
            ? { evaluationUnavailable: { kind: "context-limit", reason: "The complete immutable Review input cannot be evaluated in this context." } }
            : { reviewResponse: null, evaluationUnavailable: { kind: "context-limit", reason: "The complete immutable Review input cannot be evaluated in this context." } }),
        });
      } finally { plan.dispose(); }
    },
  });
  await new FlowReviewCommand().execute({ _rawArgs: process.argv.slice(2) });
} catch (error) {
  const failure = classifyReviewCommandError(error, "impl");
  process.stderr.write(failure?.toMarkerLine() ?? error.stack);
  process.exitCode = 1;
}
