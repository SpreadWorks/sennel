/**
 * src/flow/lib/resolve-preparing-run-id.js
 *
 * Shared helper: resolve a preparing-flow target from an explicit --run-id.
 *
 * Resolution rules (spec 220):
 *   - explicitRunId given: validate shape and existence; return the id or a
 *     structured fail envelope if invalid / unknown.
 *   - no explicitRunId: callers must supply --run-id. Preparing flows are
 *     never auto-selected, even when exactly one exists. Abandoned preparing
 *     records accumulate over time, so silent auto-selection silently targets
 *     the wrong flow once a second preparing appears.
 *   - no explicitRunId and no preparing flow exists: callers opting out via
 *     zeroPreparingAsFail:false receive {runId:null} (noop path); others
 *     receive NO_FLOW.
 */

import { Envelope } from "../../lib/flow-envelope.js";

export function resolvePreparingRunId(flowManager, explicitRunId, opts) {
  const type = opts?.type ?? "run";
  const key = opts?.key ?? "auto-check";
  const zeroPreparingAsFail = !!opts?.zeroPreparingAsFail;
  if (explicitRunId) {
    if (typeof explicitRunId !== "string" || !explicitRunId.trim()) {
      return {
        fail: Envelope.fail(type, key, "INVALID_USAGE", "--run-id must be a non-empty string"),
      };
    }
    if (!flowManager.resolvePreparingByRunId(explicitRunId)) {
      return {
        fail: Envelope.fail(
          type,
          key,
          "PREPARING_FLOW_NOT_FOUND",
          `preparing flow not found: ${explicitRunId}`,
        ),
      };
    }
    return { runId: explicitRunId };
  }

  const ids = flowManager.listPreparingFlows();

  if (ids.length === 0) {
    if (zeroPreparingAsFail) {
      return {
        fail: Envelope.fail(type, key, "NO_FLOW", "no active flow and no preparing flow found"),
      };
    }
    return { runId: null };
  }

  return {
    fail: Envelope.fail(
      type,
      key,
      "MISSING_RUN_ID",
      `--run-id is required (candidates: ${ids.join(", ")})`,
    ),
  };
}
