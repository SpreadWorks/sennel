/**
 * src/flow/lib/set-auto.js
 *
 * Enable or disable autoApprove mode.
 *
 * Dual-mode operation:
 *   - Active flow: append a typed policy Activity through the Version Store.
 *   - Preparing flow (.sennel/.active-flow.<runId>, pre-prepare): mutate the
 *     preparing state so skill prelude B.0.5 can enable auto mode BEFORE
 *     `flow prepare` creates flow.json. `run-prepare-spec` inherits only the
 *     selected autoApprove policy into the new Version-1 state.
 *
 * Preparing-flow target resolution (spec 220):
 *   - --run-id is REQUIRED in preparing mode. Auto-select heuristics are gone.
 *
 * Gate on `on`:
 *   - Spec 208 R8 / R9: `on` is gated by auto-check — if the check returns
 *     eligible:false, autoApprove is NOT updated and the CLI exits non-zero
 *     with the reason on stderr.
 *   - Spec 218: When a preparing state contains a persisted `autoCheck`
 *     (written earlier by `flow run auto-check`), the verdict is trusted
 *     verbatim and the AI is NOT invoked again.
 *   - Spec 220: phase-aware input and spec-approved skip share a single
 *     catalog resolver with run-auto-check.
 *   - Spec 232: preparing autoDesired is persisted on reject; the failed
 *     verdict is not saved and neither field enters canonical flow.json.
 *
 * ctx.value — "on" | "off"
 * ctx.runId — preparing-flow target (required in preparing mode)
 */

import { FlowCommand } from "./base-command.js";
import { VALID_AUTO_VALUES } from "../../lib/constants.js";
import { runAutoCheckCore } from "./run-auto-check.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { resolvePreparingRunId } from "./resolve-preparing-run-id.js";
import {
  CanonicalAutoCheckInputError,
  resolvePreparingAutoCheckInput,
  resolveAutoCheckInputForFlow,
  resolvePersistedAutoCheckTrust,
  isSpecApproved,
  buildSkipVerdict,
} from "./resolve-auto-check-input.js";

export default class SetAutoCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  async execute(ctx) {
    const value = ctx.value;

    if (!value || !VALID_AUTO_VALUES.includes(value)) {
      return Envelope.fail(
        "set",
        "auto",
        "INVALID_USAGE",
        `usage: flow set auto ${VALID_AUTO_VALUES.join("|")}`,
      );
    }

    const { flowManager, flowState } = ctx;
    const preparingMode = !flowState;
    let runId = null;
    if (preparingMode) {
      const resolved = resolvePreparingRunId(flowManager, ctx.runId, {
        type: "set",
        key: "auto",
        zeroPreparingAsFail: true,
      });
      if (resolved.fail) return resolved.fail;
      runId = resolved.runId;
    }

    const updatePreparing = (updater) => flowManager.mutatePreparingFlow(runId, updater);
    const updateActivePolicy = (autoApprove) => flowManager.setAutoApprove(autoApprove, {
      ...(ctx.specId ? { specId: ctx.specId } : {}),
    });

    if (value === "off") {
      if (preparingMode) {
        updatePreparing((s) => {
          s.autoApprove = false;
          s.autoDesired = false;
        });
      } else {
        updateActivePolicy(false);
      }
      return { autoApprove: false, ...(preparingMode ? { runId } : {}) };
    }

    const state = preparingMode
      ? flowManager.loadPreparingFlow(runId)
      : flowManager.load();

    // Spec-approved skip path: skip auto-check entirely (active flow only).
    if (!preparingMode && isSpecApproved(state)) {
      const autoCheck = buildSkipVerdict();
      updateActivePolicy(true);
      return { autoApprove: true, autoCheck };
    }

    // Preparing flows retain a prior auto-check verdict so `set auto on` uses
    // the exact pre-creation input. Active Version-1 flows do not cache this
    // verdict in flow.json and resolve their catalog-backed input afresh.
    let autoCheck = state?.autoCheck || null;
    const trusted = !!autoCheck;
    if (trusted) {
      const trustFailure = resolvePersistedAutoCheckTrust(state);
      if (trustFailure) autoCheck = trustFailure;
    }
    if (!autoCheck) {
      let resolved;
      try {
        resolved = preparingMode
          ? resolvePreparingAutoCheckInput(state)
          : resolveAutoCheckInputForFlow({ flowManager, state });
      } catch (error) {
        if (error instanceof CanonicalAutoCheckInputError) {
          return Envelope.fail("set", "auto", error.code, error.message);
        }
        throw error;
      }
      if (resolved.skip) {
        autoCheck = buildSkipVerdict();
      } else if (resolved.fail) {
        autoCheck = resolved.verdict;
      } else {
        autoCheck = {
          ...(await runAutoCheckCore(this.container, resolved.text)),
          ...(resolved.goalGate ? { goalGate: resolved.goalGate } : {}),
        };
      }
      if (autoCheck.eligible) {
        // A completed auto-check is worker evidence, not a mutable
        // flow.json field.  The next owning worker publishes it as a cataloged
        // result; the user-selected policy remains the only state update here.
        if (preparingMode) updatePreparing((s) => { s.autoCheck = autoCheck; });
      }
    }

    if (!autoCheck.eligible) {
      if (preparingMode) updatePreparing((s) => { s.autoDesired = true; });
      return Envelope.fail(
        "set",
        "auto",
        "AUTO_CHECK_INELIGIBLE",
        `auto-check rejected: ${autoCheck.reason || "not eligible"}`,
        autoCheck,
      );
    }

    if (preparingMode) updatePreparing((s) => { s.autoApprove = true; });
    else updateActivePolicy(true);
    return { autoApprove: true, autoCheck, trusted, ...(preparingMode ? { runId } : {}) };
  }
}
