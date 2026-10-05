/**
 * src/flow/lib/set-metric.js
 *
 * Append a metric entry to state.metrics (append-only array).
 *
 * ctx.phase   — one of VALID_PHASES (see constants.js)
 * ctx.counter — one of VALID_METRIC_COUNTERS (see constants.js)
 * ctx.taskId  — optional explicit taskId (overrides active-task inference)
 */

import { FlowCommand } from "./base-command.js";
import { VALID_PHASES, VALID_METRIC_COUNTERS } from "../../lib/constants.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { resolveCommandRouteOptions } from "../../lib/flow-options.js";

export default class SetMetricCommand extends FlowCommand {
  execute(ctx) {
    const { phase, counter } = ctx;

    if (!phase || !counter) {
      return Envelope.fail(
        "set",
        "metric",
        "INVALID_USAGE",
        "usage: flow set metric <phase> <counter> [--task-id <id>]",
      );
    }

    if (!VALID_PHASES.includes(phase)) {
      return Envelope.fail(
        "set",
        "metric",
        "INVALID_PHASE",
        `invalid phase: ${phase} (valid: ${VALID_PHASES.join(", ")})`,
      );
    }

    if (!VALID_METRIC_COUNTERS.includes(counter)) {
      return Envelope.fail(
        "set",
        "metric",
        "INVALID_ARG_VALUE",
        `invalid counter: ${counter} (valid: ${VALID_METRIC_COUNTERS.join(", ")})`,
      );
    }

    ctx.flowManager.incrementMetric(phase, counter, resolveCommandRouteOptions(ctx));

    return { phase, counter };
  }
}
