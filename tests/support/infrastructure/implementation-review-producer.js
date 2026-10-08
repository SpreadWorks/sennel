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
    const command = new RunReviewCommand({
      runCommand: (_command, _args, options) => {
        const child = spawnSync(process.execPath,
          [fileURLToPath(new URL("../impl-phase-review-worker.js", import.meta.url))], {
            ...options,
            env: { ...options.env, SENNEL_IMPL_SCENARIO_RESPONSE: this.response },
          });
        return { ...child, ok: child.status === 0 };
      },
    });
    return command.execute(ctx);
  }

  async publish(ctx) {
    const result = await this.produce(ctx);
    if (result.ok !== false) await FLOW_COMMANDS.run.review.post(ctx, result);
    return result;
  }
}
