import assert from "node:assert/strict";
import { it } from "node:test";
import { Agent, AgentInvocationConfiguration } from "../../src/lib/agent.js";

function configuration({ profile = {}, policy = {} } = {}) {
  const agent = new Agent({ config: { agent: { default: "test/exec", timeout: 30,
    profiles: { test: { "flow.acceptance.review": "test/exec" } },
    providers: { "test/exec": { command: "worker", args: ["{{PROMPT}}"], jsonOutputFlag: "--json",
      jsonSchemaFlag: "--schema", jsonSchemaMode: "inline", systemPromptFlag: "--system", workDirFlag: "--cwd", ...profile } },
    ...policy } } });
  return agent.invocationConfiguration(agent.resolve("flow.acceptance.review", { profile: "test", provider: "test/exec" }));
}

it("captures every effective invocation field through the shared profile and provider APIs", () => {
  const initial = configuration();
  assert.ok(initial instanceof AgentInvocationConfiguration);
  const serialized = initial.toJSON();
  for (const profile of [
    { command: "other-worker" }, { args: ["--alternate", "{{PROMPT}}"] }, { jsonOutputFlag: "--output-json" },
    { jsonSchemaFlag: "--other-schema" }, { jsonSchemaMode: "file" },
    { systemPromptFlag: "--other-system" }, { workDirFlag: "--other-cwd" },
  ]) assert.notDeepEqual(configuration({ profile }).toJSON(), serialized);
  for (const policy of [{ timeout: 31 }, { stdinFallbackThreshold: 10 }, { retryCount: 3 }]) {
    assert.notDeepEqual(configuration({ policy }).toJSON(), serialized);
  }
  assert.deepEqual(configuration({ profile: { env: { TOKEN: "private-credential" } } }).toJSON(), serialized);
  assert.equal(JSON.stringify(serialized).includes("private-credential"), false);
  assert.equal(Object.isFrozen(initial.args), true);
});
