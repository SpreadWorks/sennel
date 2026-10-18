import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
      runCommand: (_command, _args, options) => {
        const child = spawnSync(process.execPath,
          [fileURLToPath(new URL("../impl-phase-review-worker.js", import.meta.url))], {
            ...options,
            env: { ...options.env, SENNEL_IMPL_SCENARIO_RESPONSE: this.response,
              SENNEL_IMPL_SCENARIO_SPEC_ROOT: ctx.flowManager.specRoot },
          });
        if (child.status !== 0) workerFailure = child.error?.stack ?? child.stderr?.toString() ?? `signal: ${child.signal}`;
        return { ...child, ok: child.status === 0 };
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
