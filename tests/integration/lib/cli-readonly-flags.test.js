import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandDefinition, CommandRegistry, coreCommandRegistry } from "../../../src/lib/command-registry.js";
import { CliInvocationPolicy } from "../../../src/lib/cli-invocation-policy.js";
import { flowProcessRuntimeRequired } from "../../../src/flow/lib/process-runtime-admission.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";

function definition(readOnlyFlags = ["--inspect-only"]) {
  return new CommandDefinition({ name: "recover", command() {}, outputMode: "raw",
    args: { flags: ["--inspect-only", "--apply"], options: ["--token"] }, readOnlyFlags });
}

test("trusted conditional inspection metadata survives registry construction", () => {
  const command = definition();
  assert.deepEqual(command.readOnlyFlags, ["--inspect-only"]);
  assert.equal(Object.isFrozen(command.readOnlyFlags), true);
  const registry = new CommandRegistry([command]);
  assert.equal(new CliInvocationPolicy(registry, ["recover", "--inspect-only"]).readOnly, true);
  assert.equal(new CliInvocationPolicy(registry, ["recover", "--apply"]).readOnly, false);
});

test("conditional inspection flags require unique declared flag metadata", () => {
  for (const input of [null, "--inspect-only", ["--token"], ["--missing"], ["--inspect-only", "--inspect-only"]]) {
    assert.throws(() => definition(input), TypeError, JSON.stringify(input));
  }
});

test("a conditional inspection flag is effective only in a declared option position", () => {
  const registry = new CommandRegistry([definition()]);
  for (const argv of [
    ["recover"], ["recover", "--apply"], ["recover", "--token", "--inspect-only"],
    ["recover", "--", "--inspect-only"], ["recover", "--unknown", "--inspect-only"],
    ["unregistered", "--inspect-only"],
  ]) assert.equal(new CliInvocationPolicy(registry, argv).readOnly, false, JSON.stringify(argv));
  for (const argv of [["recover", "--inspect-only"], ["recover", "--token", "literal", "--inspect-only"]]) {
    assert.equal(new CliInvocationPolicy(registry, argv).readOnly, true, JSON.stringify(argv));
  }
});

test("real recovery preview uses inspection storage while digest apply keeps ordinary storage", () => {
  const route = ["flow", "run", "recover-spec-gate-repair"];
  assert.equal(new CliInvocationPolicy(coreCommandRegistry, [...route, "--preview"]).readOnly, true);
  for (const argv of [
    [...route, "--preview-digest", "a".repeat(64)],
    [...route, "--expect-binding", "--preview"],
    [...route, "--", "--preview"],
    [...route, "--unknown", "--preview"],
  ]) assert.equal(new CliInvocationPolicy(coreCommandRegistry, argv).readOnly, false, JSON.stringify(argv));
});

test("a read-only run invocation cannot attach the canonical Flow process writer", () => {
  const input = { ctx: { root: "/selected-project", flowManager: {},
    flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION } },
    envelopeType: "run", envelopeKey: "recover-spec-gate-repair", input: { preview: true } };
  assert.equal(flowProcessRuntimeRequired({ ...input, readOnly: true }), false);
  assert.equal(flowProcessRuntimeRequired({ ...input, readOnly: false }), true);
  assert.equal(flowProcessRuntimeRequired({ ...input, input: { previewDigest: "a".repeat(64) }, readOnly: false }), true);
});
