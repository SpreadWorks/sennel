import assert from "node:assert/strict";
import { it } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowExecutionCommand } from "../../../src/flow/lib/flow-execution-command.js";
import { ExecuteCommandDirective } from "../../../src/flow/lib/next-action-directive.js";
import { AgentAuthenticationFailure } from "../../../src/lib/agent-failure.js";
import {
  ExternalBlockedOutcome,
  StepAttempt,
} from "../../../src/flow/lib/step-outcome.js";

it("keeps a guarded mechanical recovery successful after an external-blocked attempt", async () => {
  class MechanicalRecoveryCommand extends Command {
    static outputMode = "envelope";

    execute() {
      return {
        stepAttempt: new StepAttempt({
          runId: "run-mechanical-recovery",
          stepId: "spec-gate",
          attempt: 1,
          outcome: new ExternalBlockedOutcome({
            reason: "mechanical",
            resumeInstruction: "Resolve the mechanical blocker.",
          }),
        }).toJSON(),
        directive: new ExecuteCommandDirective({
          actionId: "RECOVER_CANONICAL_REVIEW_PASS",
          command: new FlowExecutionCommand({ group: "run", subcommand: "recover-review-pass", args: ["--phase", "spec"] }),
          instruction: "Recover the exact canonical PASS projection.",
          reason: "The prior mutable projection was overwritten.",
        }).toJSON(),
      };
    }
  }

  let stdout = "";
  let exitCode = 0;
  await dispatch({
    container: { has: () => false, get: () => null },
    entry: {
      args: {},
      requiresFlow: false,
      command: async () => ({ default: MechanicalRecoveryCommand }),
    },
    argv: [],
    envelopeType: "get",
    envelopeKey: "next-action",
    stdout: (text) => { stdout += text; },
    stderr: () => {},
    setExitCode: (code) => { exitCode = code; },
  });

  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.directive.actionId, "RECOVER_CANONICAL_REVIEW_PASS");
  assert.deepEqual(envelope.errors, []);
  assert.equal(exitCode, 0);
});

it("preserves typed agent failure metadata in an envelope boundary", async () => {
  const failure = new AgentAuthenticationFailure({ message: "HTTP 401 Unauthorized" })
    .recordAttempts(1, 3);
  class AgentFailureCommand extends Command {
    static outputMode = "envelope";

    execute() {
      throw failure;
    }
  }

  let stdout = "";
  let exitCode = 0;
  await dispatch({
    container: { has: () => false, get: () => null },
    entry: {
      args: {},
      requiresFlow: false,
      command: async () => ({ default: AgentFailureCommand }),
    },
    argv: [],
    envelopeType: "run",
    envelopeKey: "agent-boundary",
    stdout: (text) => { stdout += text; },
    stderr: () => {},
    setExitCode: (code) => { exitCode = code; },
  });

  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.errors[0].code, "AGENT_AUTHENTICATION_FAILED");
  const { directive, ...failureData } = envelope.data;
  assert.deepEqual(failureData, failure.toJSON());
  assert.equal(directive.kind, "single_user_action");
  assert.equal(envelope.guidance.cause.code, failure.code);
  assert.equal(exitCode, 1);
});
