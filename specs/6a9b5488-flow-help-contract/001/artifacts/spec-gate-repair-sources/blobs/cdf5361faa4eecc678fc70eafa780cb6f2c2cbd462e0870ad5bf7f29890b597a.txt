import { Envelope } from "../../lib/flow-envelope.js";
import { resolveTaskExecutionOverrun } from "../definition.js";
import { FlowCommand } from "./base-command.js";
import { readTaskExecutionOverrunFacts } from "./task-execution-overrun.js";

function replayedRecovery({ flowManager, specId }) {
  const state = flowManager.canonicalState(specId);
  const recovery = flowManager.activityLedger(specId).at(-1) ?? null;
  if (state?.current === null || state?.attempt?.failure?.category !== "semantic"
    || recovery?.transition?.operation !== "recover_task_execution_overrun") return null;
  const taskId = recovery.nodeId?.endsWith("-impl")
    ? recovery.nodeId.slice(0, -"-impl".length)
    : null;
  if (taskId === null || state.current.at(-1) !== `${taskId}-gate`
    || state.findNode(`${taskId}-impl`)?.status !== "done"
    || state.findNode(`${taskId}-review`)?.status !== "done"
    || state.findNode(`${taskId}-gate`)?.status !== "in_progress") return null;
  const completedRounds = flowManager.taskMutationLineages({ specId, taskId })
    .filter((lineage) => lineage.role === "implementation").length;
  return { taskId, completedRounds };
}

/** Close only an already Definition-selected stale Task implementation round. */
export default class RunRecoverTaskExecutionOverrunCommand extends FlowCommand {
  constructor() { super({ explicitTargetResolution: true }); }

  execute(ctx) {
    try {
      const specId = ctx.specId ?? ctx.flowState?.specId;
      const facts = readTaskExecutionOverrunFacts({ flowManager: ctx.flowManager, specId });
      const decision = resolveTaskExecutionOverrun(facts);
      if (decision === null) {
        const replay = replayedRecovery({ flowManager: ctx.flowManager, specId });
        if (replay === null) throw new Error("Definition does not select a Task execution overrun recovery");
        return Envelope.ok("run", "recover-task-execution-overrun", {
          ...replay,
          nextStep: ctx.flowManager.canonicalState(specId).nextAction()?.nodeId ?? null,
          replayed: true,
        });
      }
      const recovered = ctx.flowManager.recoverTaskExecutionOverrun({ specId, decision });
      return Envelope.ok("run", "recover-task-execution-overrun", {
        taskId: decision.facts.taskId,
        completedRounds: decision.facts.completedRounds,
        nextStep: recovered.nextAction()?.nodeId ?? null,
        replayed: false,
      });
    } catch (error) {
      return Envelope.fail("run", "recover-task-execution-overrun", error.code || "TASK_EXECUTION_OVERRUN_NOT_ADMITTED", error.message);
    }
  }
}
