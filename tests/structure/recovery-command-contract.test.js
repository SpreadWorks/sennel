import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { specStepRegistrations } from "../../src/flow/engine/composition/spec.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { SourceRepository, MemorySourceRepository } from "../support/structure/source-repository.js";
import { SourceModule, readInvocations, readClassMember, readObjectProperty } from "../support/structure/source-reader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const disk = new SourceRepository(root);
const original = new Map(disk.list("src").map((file) => [file, disk.read(file)]));
const scope = new StructureScope(root, "src/flow/steps/spec", specStepRegistrations);
let inspectionSeed = null;

function inspect(files = original, routes = false) {
  const repository = new MemorySourceRepository(files);
  const checker = inspectionSeed === null ? new StructureChecker(scope, repository) : inspectionSeed.fork(repository);
  if (routes) checker.check();
  const report = checker.checkRecoveryCommands();
  if (inspectionSeed === null && files === original && report.ok) inspectionSeed = checker;
  return report;
}

function green(files = original, routes = false) {
  const report = inspect(files, routes);
  assert.equal(report.ok, true, report.diagnostics.map(String).join("\n"));
  return report;
}

function rejectedMutation(file, before, after, rule, line = null) {
  const source = original.get(file);
  assert.equal(source.includes(before), true, `${file}: fixture target exists`);
  const files = new Map(original);
  files.set(file, source.replace(before, after));
  const report = inspect(files);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file);
  assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
  assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
  assert.ok(diagnostic.trace.includes(file));
  if (line !== null) assert.equal(diagnostic.line, line);
  files.set(file, source);
  green(files);
}

test("production recovery constructors and Definition commands share the existing registry and closed Step routes", () => {
  const report = green(original, true);
  assert.ok(report.reverseIndexed.size > 0);
});

test("a discovered production directive rejects string-only construction at its source location", () => {
  const directiveFile = "src/flow/lib/next-action-directive.js";
  let inspected = 0;
  for (const [file, source] of original) {
    const module = new SourceModule(file, source);
    const names = new Set(module.references.flatMap((reference) => [...reference.bindings]
      .filter(([, exported]) => exported === "ExecuteCommandDirective").map(([local]) => local)));
    if (file === directiveFile) names.add("ExecuteCommandDirective");
    for (const call of readInvocations(module).filter((entry) => entry.constructed && names.has(entry.name))) {
      const command = call.arguments.length === 1 && readObjectProperty(call.arguments[0], "command");
      assert.ok(command, `${file}:${call.token.line} has structured command input`);
      const start = command.token.offset;
      const end = command.tokens.at(-1).offset + command.tokens.at(-1).value.length;
      // Include shorthand command properties while preserving the surrounding
      // object and all instruction/reason fields unchanged.
      const property = source.slice(start, end);
      const altered = source.slice(0, start) + 'nextAction: "sennel flow run display-only"' + source.slice(end);
      const files = new Map(original);
      files.set(file, altered);
      const failures = inspect(files).diagnostics.filter((entry) => entry.rule === "R01" && entry.file === file
        && entry.line === call.token.line);
      assert.equal(failures.length, 1, `${file}:${call.token.line} rejects ${property}`);
      assert.ok(failures[0].column > 0 && failures[0].trace.includes(file));
      files.set(file, source);
      green(files);
      inspected++;
      break;
    }
    if (inspected > 0) break;
  }
  assert.ok(inspected > 0, "production callers were discovered");
});

for (const [name, before, after] of [
  ["registry disconnect", "const entry = flowCommands[command.group]?.[command.subcommand];", "const entry = ctx.entry;"],
  ["group discard", "const entry = flowCommands[command.group]?.[command.subcommand];", "const entry = flowCommands.run?.[command.subcommand];"],
  ["subcommand discard", "const entry = flowCommands[command.group]?.[command.subcommand];", "const entry = flowCommands[command.group]?.dispatch;"],
  ["args discard", "...command.args,\n        ...(injectAgentWorkDir", "...[],\n        ...(injectAgentWorkDir"],
  ["duplicate target guards", "...command.args,\n        ...(injectAgentWorkDir", "...command.args, ...targetGuardArguments(target),\n        ...(injectAgentWorkDir"],
  ["duplicate runtime option", '...(injectAgentWorkDir ? ["--agent-work-dir", ctx.agentWorkDir] : []),', '...(injectAgentWorkDir ? ["--agent-work-dir", ctx.agentWorkDir] : []), ...(ctx.agentWorkDir ? ["--agent-work-dir", ctx.agentWorkDir] : []),'],
  ["undeclared runtime option", 'ctx.agentWorkDir && runtimeOptions.includes("--agent-work-dir")', "ctx.agentWorkDir"],
  ["runtime option overwrite", '!command.args.some((arg) => arg === "--agent-work-dir" || arg.startsWith("--agent-work-dir="))', "true"],
  ["unknown early execution branch", "async runRegisteredFlowCommand(ctx, target, command, authorization = null) {", "async runRegisteredFlowCommand(ctx, target, command, authorization = null) { if (ctx.skip) return null;"],
  ["shadowed dispatcher capability", "async runRegisteredFlowCommand(ctx, target, command, authorization = null) {", "async runRegisteredFlowCommand(ctx, target, command, authorization = null, dispatch) {"],
]) {
  test(`registered recovery rejects ${name} independently`, () => {
    rejectedMutation("src/flow/lib/run-dispatch.js", before, after, "R02");
  });
}

test("recovery invocation cannot be omitted before registry execution", () => {
  rejectedMutation("src/flow/lib/run-dispatch.js", "invocation.assertCommandSelection(action.directive);", "", "R03");
});

test("selected recovery rechecks canonical state before execution", () => {
  rejectedMutation("src/flow/lib/run-dispatch.js", "const selected = await this.fetchNextAction(target);", "const selected = action.nextAction;", "R03");
});

test("canonical invocation comparison cannot discard structured command arguments", () => {
  rejectedMutation("src/flow/lib/dispatch-invocation.js",
    "stableStringify(selected.command.toJSON()) !== stableStringify(directive.command.toJSON())", "false", "R03");
});

test("canonical command comparison cannot reparse mutable serialized action data", () => {
  rejectedMutation("src/flow/lib/dispatch-invocation.js", "const selected = this.action.directive;",
    "const selected = NextActionDirective.fromStored(this.action.nextAction.directive);", "R03");
});

test("action identity must capture its typed directive before mutable JSON can change", () => {
  rejectedMutation("src/flow/lib/dispatch-invocation.js", "this.directive = NextActionDirective.fromStored(nextAction.directive);",
    "this.directive = nextAction.directive;", "R03");
});

test("captured command identity rejects unknown mutation after typed capture", () => {
  rejectedMutation("src/flow/lib/dispatch-invocation.js", "this.directive = NextActionDirective.fromStored(nextAction.directive);",
    "this.directive = NextActionDirective.fromStored(nextAction.directive); Object.assign(this, { directive: nextAction.directive });", "R03");
});

test("both recovery and upper admission retain exact approval receipt validation", () => {
  rejectedMutation("src/flow/lib/run-dispatch.js",
    "receiptMutation.assertCurrent({ ctx, fingerprint: this.repositoryFingerprint, activeAction, flowState });",
    "invocation.assertCurrent(activeAction, flowState);", "R03");
});

test("recovery preserves approved invocation authorization at registered execution", () => {
  rejectedMutation("src/flow/lib/run-dispatch.js",
    "return this.runRegisteredFlowCommand(ctx, target, action.directive.command,\n      invocation.approved ? invocation.authorization : null);",
    "return this.runRegisteredFlowCommand(ctx, target, action.directive.command);", "R03");
});

test("an unhandled ExecuteCommandDirective cannot fall through to the normal Step worker", () => {
  rejectedMutation("src/flow/lib/run-dispatch.js", "if (action.directive instanceof ExecuteCommandDirective) {",
    "if (dispatcherOwnedRecovery != null) {", "R03");
});

test("target binding cannot append its guards a second time", () => {
  const file = "src/flow/lib/flow-execution-command.js";
  const module = new SourceModule(file, original.get(file));
  const method = readClassMember(module, "FlowExecutionCommand", "bindTarget");
  assert.ok(method);
  rejectedMutation(file, "...this.args, ...binding.guardArguments()", "...this.args, ...binding.guardArguments(), ...binding.guardArguments()", "R02", method.token.line);
});

test("command projection cannot duplicate state guards", () => {
  rejectedMutation("src/flow/lib/guarded-command.js", "...command.args, ...guardArgumentsForState(state)",
    "...command.args, ...guardArgumentsForState(state), ...guardArgumentsForState(state)", "R02");
});

for (const [name, file, before, after] of [
  ["pre hook", "src/lib/dispatcher.js", "await entry.pre(hookCtx);", "await Promise.resolve();"],
  ["post hook", "src/lib/dispatcher.js", "const postResult = await entry.post(hookCtx, result);", "const postResult = result;"],
  ["completion receipt", "src/lib/dispatcher.js", "commitCompletion: true,", "commitCompletion: false,"],
  ["finalization authorization", "src/flow/lib/run-dispatch.js", "? invocation.authorization : null,", "? null : null,"],
  ["registered hook context", "src/flow/lib/run-dispatch.js", "...buildFlowCommandHookContext(container, entry, input)", "...input"],
]) {
  test(`registered recovery cannot bypass ${name}`, () => rejectedMutation(file, before, after, "R04"));
}

test("instruction and reason prose alone do not alter recovery architecture", () => {
  const file = "src/flow/lib/get-next-action.js";
  const source = original.get(file);
  const files = new Map(original);
  files.set(file, source.replace("Claim the current Definition-selected action through the canonical Store before starting its worker.",
    "現在の選択済み操作を確保してください。")
    .replace("get-next-action is read-only; the explicit claim command rechecks canonical facts immediately before creating the Attempt.",
      "保存済みの状態を再確認してから実行します。"));
  green(files);
  files.set(file, source);
  green(files);
});
