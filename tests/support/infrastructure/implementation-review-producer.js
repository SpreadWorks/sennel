import { fileURLToPath } from "node:url";
import { NodeScriptInvocation } from "../../../src/lib/command-invocation.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";

/** Production Review claim, protocol, seal and publication with a deterministic provider. */
export class ImplementationReviewProducer {
  constructor({ findings = [] } = {}) {
    this.response = JSON.stringify({
      blockingFindings: findings.filter((finding) => finding.disposition === "must-fix"),
      nonBlockingImprovements: findings.filter((finding) => finding.disposition !== "must-fix"),
    });
    Object.freeze(this);
  }

  async produce(ctx) {
    let workerFailure = null;
    const command = new RunReviewCommand({
      runCommand: async (_command, _args, options) => {
        const { cwd, env, stdio, ...executionOptions } = options;
        const child = await runManagedCmdAsync(new NodeScriptInvocation({
          script: fileURLToPath(new URL("../impl-phase-review-worker.js", import.meta.url)),
          cwd, stdio,
          env: { ...env, SENNEL_IMPL_SCENARIO_RESPONSE: this.response,
            SENNEL_IMPL_SCENARIO_SPEC_ROOT: ctx.flowManager.specRoot.toString() },
        }), executionOptions);
        if (child.status !== 0) workerFailure = child.stderr?.toString() ?? `signal: ${child.signal}`;
        return child;
      },
    });
    const result = await command.execute(ctx);
    if (workerFailure !== null) throw new Error(`Review fixture worker failed: ${workerFailure}`);
    return result;
  }

  async publish(ctx) {
    const result = await this.produce(ctx);
    if (result.ok !== false) await FLOW_COMMANDS.run.review.post(ctx, result);
    return result;
  }
}
