import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, AGENT_EXTERNAL_EXECUTION_INSTRUCTION } from "../../src/lib/agent.js";
import { AgentPermissionConfigurationFailure } from "../../src/lib/agent-failure.js";

function agent(args) {
  return new Agent({ config: { agent: { default: "fixture", providers: { fixture: { command: "worker", args } } } } });
}

test("literal profiles and prompt contents do not implicitly request a control directory", () => {
  const prompt = '$& $1 {{CONTROL_DIRECTORY}} {{CONTROL_DIRECTORY_JSON}}';
  const effectivePrompt = AGENT_EXTERNAL_EXECUTION_INSTRUCTION + "\n\n" + prompt;
  const value = agent(["--literal", "{{CONTROL_DIRECTORY_UNKNOWN}}", "prefix={{PROMPT}}"]);
  const projection = value.projectInvocation(prompt);
  assert.deepEqual(projection.finalArgs, ["--literal", "{{CONTROL_DIRECTORY_UNKNOWN}}", "prefix=" + effectivePrompt]);
  assert.equal(projection.promptCharacterCount, ("prefix=" + effectivePrompt).length);
  assert.deepEqual(agent(["--literal"]).projectInvocation(prompt).finalArgs, ["--literal", effectivePrompt]);
});

for (const token of ["{{CONTROL_DIRECTORY}}", "{{CONTROL_DIRECTORY_JSON}}"])
  test(`explicit ${token} requires an active typed runtime instead of environment authority`, () => {
    const value = agent(["--directory=" + token, "{{PROMPT}}"]);
    assert.throws(() => value.projectInvocation("input", { executionEnvironment: { CONTROL_DIRECTORY: "/not-authority" } }),
      (error) => error instanceof AgentPermissionConfigurationFailure
        && error.code === "AGENT_PERMISSION_CONFIGURATION_FAILED" && /active managed execution scope/.test(error.message));
  });
