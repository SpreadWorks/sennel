import { Command } from "../../lib/command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { runtimeLogFileForContext } from "../../lib/runtime-log.js";
import {
  FlowTargetExpectation,
  targetMismatchEnvelopeForInput,
} from "../../lib/flow-target-guard.js";
import { resolveFlowContext } from "./flow-context.js";

function positiveInteger(value, name) {
  if (value == null) return null;
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw Object.assign(new Error(`${name} must be a positive integer`), { code: "INVALID_ARG_VALUE" });
  }
  return Number(value);
}

function parseRunId(value) {
  if (value == null) return { runId: null, sequence: null };
  const text = String(value).trim();
  if (!text) throw Object.assign(new Error("--run-id must be non-empty"), { code: "INVALID_ARG_VALUE" });
  const match = text.match(/^(.+)#([1-9]\d*)$/);
  if (!match) return { runId: text, sequence: null };
  return { runId: match[1], sequence: Number(match[2]) };
}

function outputEnvelope(envelope) {
  process.stdout.write(JSON.stringify(envelope.toJSON(), null, 2) + "\n");
  if (!envelope.ok) process.exitCode = 1;
}

function fail(code, message, data = null) {
  outputEnvelope(Envelope.fail("get", "runtime-log", code, message, data));
}

export default class GetRuntimeLogCommand extends Command {
  static outputMode = "raw";

  buildContext(input) {
    return {
      ...resolveFlowContext(this.container, {
        allowMissingActive: true,
        explicitTargetResolution: true,
        mismatchTargetResolution: true,
        preparingRunIdSelection: false,
        input,
      }),
      ...input,
    };
  }

  execute(ctx) {
    try {
      const expectation = new FlowTargetExpectation(ctx);
      if (expectation.empty) {
        throw Object.assign(
          new Error("at least one target expectation is required"),
          { code: "ARGS_ERROR" },
        );
      }
      if (ctx.flowResolutionError) {
        fail(
          ctx.flowResolutionError.code || "FLOW_TARGET_NOT_FOUND",
          ctx.flowResolutionError.message,
          ctx.flowResolutionError.data,
        );
        return;
      }
      const targetState = ctx.preparingFlowState ?? ctx.flowState;
      if (!targetState) {
        fail("FLOW_TARGET_NOT_FOUND", "explicit flow target not found");
        return;
      }
      const mismatch = targetMismatchEnvelopeForInput({
        type: "get",
        key: "runtime-log",
        input: ctx,
        flowState: targetState,
        context: ctx,
      });
      if (mismatch) {
        outputEnvelope(mismatch);
        return;
      }
      if (ctx.format != null && ctx.format !== "json") {
        throw Object.assign(new Error("--format accepts only json"), { code: "INVALID_ARG_VALUE" });
      }
      const explicitSequence = positiveInteger(ctx.sequence, "--sequence");
      const parsedRunId = parseRunId(ctx.runId);
      if (explicitSequence != null && parsedRunId.sequence != null && explicitSequence !== parsedRunId.sequence) {
        throw Object.assign(new Error("--sequence conflicts with --run-id sequence"), { code: "INVALID_ARG_VALUE" });
      }
      const sequence = parsedRunId.sequence ?? explicitSequence;
      const file = runtimeLogFileForContext({
        root: ctx.root,
        specId: targetState.specId || null,
      });
      const block = file.select({
        sequence,
        runId: parsedRunId.runId,
        ownerRunId: targetState.runId,
        latestNonRuntimeLog: sequence == null && parsedRunId.runId == null,
      });
      if (!block) {
        fail("RUNTIME_LOG_NOT_FOUND", "runtime log block not found");
        return;
      }
      if (ctx.format === "json") {
        outputEnvelope(Envelope.ok("get", "runtime-log", block.toJSON()));
        return;
      }
      process.stdout.write(block.text.endsWith("\n") ? block.text : `${block.text}\n`);
    } catch (err) {
      fail(err.code || "ARGS_ERROR", err.message || String(err), err.data);
    }
  }
}
