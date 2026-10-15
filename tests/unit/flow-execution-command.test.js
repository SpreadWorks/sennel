import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowExecutionCommand } from "../../src/flow/lib/flow-execution-command.js";
import { ExecuteCommandDirective, NextActionDirective } from "../../src/flow/lib/next-action-directive.js";
import { RetryRecoveryInput } from "../../src/flow/lib/retry-recovery.js";

test("command JSON roundtrip retains exact immutable argv and derives its display", () => {
  const args = ["reset", "review", "test", "--reason", " 日本語 '引用' \"二重引用\"\n two words ", "--yes", ""];
  const command = new FlowExecutionCommand({ group: "set", subcommand: "retry", args });
  args[4] = "changed caller value";
  assert.equal(command.args[4], " 日本語 '引用' \"二重引用\"\n two words ");
  assert.throws(() => command.args.push("mutation"), TypeError);
  const restored = FlowExecutionCommand.fromStored(JSON.parse(JSON.stringify(command)));
  assert.deepEqual(restored.runArguments(), ["retry", ...command.args]);
  assert.equal(restored.toString(), command.toString());
  assert.match(command.toString(), /'"'"'/);
  assert.ok(command.toString().endsWith(" ''"));

  const directive = new ExecuteCommandDirective({ actionId: "RECOVER_EXHAUSTED_TOOLING_RETRY",
    command, instruction: "Apply the selected command.", reason: "Canonical recovery is available." });
  const stored = JSON.parse(JSON.stringify(directive));
  const readback = NextActionDirective.fromStored(stored);
  assert.ok(readback.command instanceof FlowExecutionCommand);
  assert.deepEqual(readback.command.args, command.args);
  assert.equal(readback.nextAction, command.toString());
  assert.throws(() => NextActionDirective.fromStored({ ...stored, nextAction: `${stored.nextAction} --yes` }), /does not match command/);
  const { command: omitted, ...oldDirective } = stored;
  assert.throws(() => NextActionDirective.fromStored(oldDirective), /stored flow execution command/);
  assert.throws(() => new ExecuteCommandDirective(oldDirective), /requires FlowExecutionCommand/);
  const longCommand = new FlowExecutionCommand({ group: "run", subcommand: "claim-next-action", args: ["日本語".repeat(2000)] });
  const longDirective = new ExecuteCommandDirective({ actionId: "CLAIM_NEXT_ACTION", command: longCommand,
    instruction: "Apply the selected command.", reason: "Canonical command selected." });
  assert.deepEqual(NextActionDirective.fromStored(JSON.parse(JSON.stringify(longDirective))).command.args, longCommand.args);
});

test("command rejects invalid groups, tokens, persisted schemas and argv at its value boundary", () => {
  for (const value of [
    { group: "get", subcommand: "status" },
    { group: "run", subcommand: "review phase" },
    { group: "run", subcommand: "" },
    { group: "run", subcommand: "review", args: ["bad\0argument"] },
    { group: "run", subcommand: "review", args: [42] },
    { group: "run", subcommand: "review", args: Array(1) },
  ]) assert.throws(() => new FlowExecutionCommand(value), /flow execution command/);
  assert.throws(() => FlowExecutionCommand.fromStored({ group: "run", subcommand: "review", args: [], agentWorkDir: "/runtime" }), /stored flow execution command/);
});

test("retry reason retains original argv until the existing CLI input normalizes it", () => {
  const reason = "  日本語の復旧理由 'quoted' \"double quoted\"\nwith a retained newline  ";
  const command = new FlowExecutionCommand({ group: "set", subcommand: "retry",
    args: ["reset", "review", "test", "--reason", reason, "--yes"] });
  assert.equal(FlowExecutionCommand.fromStored(JSON.parse(JSON.stringify(command))).args[4], reason);
  assert.equal(new RetryRecoveryInput({ action: command.args[0], kind: command.args[1], phase: command.args[2],
    reason: command.args[4], yes: true }).reason, reason.trim());
});
