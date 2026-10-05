/**
 * src/flow/lib/base-command.js
 *
 * Base class for all flow commands.
 *
 * Container connection point (spec 187 R1):
 *   - run(container, input) is the entrypoint called by the dispatcher.
 *   - The base class stores the container, assembles the execution context
 *     from it (root, mainRoot, config, flowManager, flowState, …), merges
 *     parsed CLI input, and calls execute(ctx).
 *   - Subclasses access shared dependencies via this.container.get(name)
 *     or via the ctx fields built by the base; they do not reach back into
 *     the dispatcher for re-resolution.
 */

import { Command } from "../../lib/command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { flowTargetExpectation, resolveFlowContext } from "./flow-context.js";
import {
  buildTargetMismatchEnvelope,
  targetMismatchEnvelopeForInput,
} from "../../lib/flow-target-guard.js";

export class FlowCommand extends Command {
  /** All flow commands emit JSON envelopes. */
  static outputMode = "envelope";

  /**
   * @param {Object} [options]
   * @param {boolean} [options.requiresFlow=true] - Whether this command requires an active flow
   * @param {boolean} [options.explicitTargetResolution=false] - Resolve guarded targets before ambient cwd authority
   * @param {boolean} [options.mismatchTargetResolution=false] - Resolve an identity match before reporting stale binding authority
   * @param {boolean} [options.recoveryTargetResolution=false] - Resolve only management identity/state for recovery commands
   * @param {boolean} [options.positionalRunIdTarget=false] - Treat a positional runId as the target when no runId guard is supplied
   * @param {boolean} [options.specOptionAsTarget=false] - Treat a command's --spec selector as its explicit Flow target
   * @param {boolean} [options.skipAmbientFlowContext=false] - Run without resolving ambient Flow state or target context
   */
  constructor({
    requiresFlow = true,
    targetGuard = true,
    explicitTargetResolution = false,
    mismatchTargetResolution = false,
    recoveryTargetResolution = false,
    positionalRunIdTarget = false,
    specOptionAsTarget = false,
    skipAmbientFlowContext = false,
  } = {}) {
    super();
    this.requiresFlow = requiresFlow;
    this.targetGuard = targetGuard;
    this.explicitTargetResolution = explicitTargetResolution;
    this.mismatchTargetResolution = mismatchTargetResolution;
    this.recoveryTargetResolution = recoveryTargetResolution;
    this.positionalRunIdTarget = positionalRunIdTarget;
    this.specOptionAsTarget = specOptionAsTarget;
    this.skipAmbientFlowContext = skipAmbientFlowContext;
  }

  /**
   * Run the command. The dispatcher passes the shared container and a
   * parsed input object (CLI flags / options / positional values).
   * @param {import("../../lib/container.js").Container} container
   * @param {Object} [input={}]
   * @returns {Promise<Object>|Object}
   * @throws {Error}
   */
  async run(container, input = {}) {
    this.container = container;
    if (this.skipAmbientFlowContext) {
      return this.execute({
        container,
        ...input,
        flowCommandBoundary: true,
      });
    }
    const targetInput = this.specOptionAsTarget === true
      && input.expectSpec == null
      && input.spec != null
      ? { ...input, expectSpec: input.spec }
      : input;
    let targetExpectation;
    try {
      targetExpectation = flowTargetExpectation({
        input: targetInput,
        positionalRunIdTarget: this.positionalRunIdTarget,
      });
    } catch {
      return targetMismatchEnvelopeForInput({
        type: input._envelopeType || "run",
        key: input._envelopeKey || "flow",
        input: targetInput,
        flowState: null,
      });
    }
    const ctx = {
      ...resolveFlowContext(container, {
        allowMissingActive: !this.requiresFlow,
        explicitTargetResolution: this.explicitTargetResolution,
        mismatchTargetResolution: this.mismatchTargetResolution,
        recoveryTargetResolution: this.recoveryTargetResolution,
        positionalRunIdTarget: this.positionalRunIdTarget,
        preparingRunIdSelection: this.positionalRunIdTarget ? false : undefined,
        input,
        targetExpectation,
      }),
      ...input,
      flowCommandBoundary: true,
    };
    if (ctx.flowResolutionError) {
      if (ctx.flowResolutionError.code === "ACTIVE_FLOW_MISMATCH") {
        return buildTargetMismatchEnvelope({
          type: input._envelopeType || "run",
          key: input._envelopeKey || "flow",
          data: ctx.flowResolutionError.data,
        });
      }
      if (this.explicitTargetResolution) {
        return Envelope.fail(
          input._envelopeType || "run",
          input._envelopeKey || "flow",
          ctx.flowResolutionError.code || "FLOW_TARGET_RESOLUTION_FAILED",
          ctx.flowResolutionError.message,
          ctx.flowResolutionError.data,
        );
      }
      if (this.requiresFlow) throw ctx.flowResolutionError;
    }
    if (this.requiresFlow && !ctx.flowState) {
      throw new Error("no active flow (flow.json not found)");
    }
    if (this.targetGuard) {
      const mismatch = targetMismatchEnvelopeForInput({
        type: input._envelopeType || "run",
        key: input._envelopeKey || "flow",
        input,
        expectation: ctx.targetExpectation,
        flowState: ctx.preparingFlowState ?? ctx.flowState,
        mainRoot: ctx.mainRoot || ctx.root,
        authorityRoot: ctx.executionRoot || ctx.root,
        worktreePath: ctx.flowState?.worktree === true ? (ctx.executionRoot || ctx.root) : undefined,
        context: ctx,
      });
      if (mismatch) {
        return mismatch;
      }
    }
    return this.execute(ctx);
  }

  /**
   * Command logic. Must be overridden by subclasses.
   * @param {Object} ctx - resolved flow context merged with parsed CLI input
   * @returns {Promise<Object>|Object}
   * @throws {Error}
   */
  execute(ctx) {
    throw new Error("execute() must be implemented by subclass");
  }
}

export { resolveExplicitTaskOption } from "../../lib/flow-options.js";
