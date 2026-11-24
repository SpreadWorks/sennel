import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { Logger } from "../../../src/lib/log.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("Agent consumes canonical sibling-repository schema and logs while preserving execution cwd and refusing foreign scratch", async (t) => {
  const root = createTmpDir("agent-canonical-scratch-");
  let logger;
  t.after(async () => {
    try { await logger?.flush(); }
    finally { removeTmpDir(root); }
  });
  const mainRoot = path.join(root, "main");
  const executionRoot = path.join(root, "execution");
  const foreignRoot = path.join(root, "foreign");
  for (const directory of [mainRoot, executionRoot, foreignRoot]) fs.mkdirSync(directory);
  const sentinel = path.join(foreignRoot, "sentinel");
  const sentinelBytes = Buffer.from([0, 42, 255]);
  fs.writeFileSync(sentinel, sentinelBytes);
  const paths = new TemporaryPaths(mainRoot);
  const temporaryRoot = paths.flow("001-canonical-scratch", "run-canonical-scratch");
  const logDir = paths.logs();
  const admissions = path.join(executionRoot, "provider-admissions");
  const script = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(admissions)}, 'admitted\\n');
    const schemaPath = process.argv[process.argv.indexOf('--schema') + 1];
    process.stdout.write(JSON.stringify({cwd:process.cwd(),schemaPath,schema:JSON.parse(fs.readFileSync(schemaPath,'utf8'))}));
  `;
  const config = { agent: { default: "test/exec", timeout: 20, retryCount: 0,
    providers: { "test/exec": { command: process.execPath, args: ["-e", script, "{{PROMPT}}"],
      jsonSchemaFlag: "--schema", jsonSchemaMode: "file" } } } };
  logger = new Logger({ logDir, enabled: true, cwd: executionRoot });
  const agent = new Agent({ config,
    paths: { root: executionRoot, repositoryRoot: mainRoot, agentWorkDir: path.join(executionRoot, ".tmp"), logDir },
    registry: new ProviderRegistry(config.agent.providers), logger });
  const schema = { type: "object", properties: { verified: { type: "boolean" } } };
  const options = { temporaryRoot, executionWorkDir: executionRoot, jsonSchema: schema, flowAttribution: "none", cacheMode: "bypass", retryCount: 0 };
  const response = JSON.parse(await agent.call("inspect the complete schema", options));
  await logger.flush();
  assert.equal(response.cwd, fs.realpathSync(executionRoot));
  assert.equal(path.dirname(response.schemaPath), temporaryRoot);
  assert.deepEqual(response.schema, schema);
  assert.equal(fs.existsSync(response.schemaPath), false, "the exact provider-consumed schema is released after its process exits");
  assert.ok(fs.readdirSync(logDir).some((name) => name.endsWith(".jsonl")));
  assert.equal(fs.existsSync(path.join(executionRoot, ".tmp", "logs")), false);
  const admitted = fs.readFileSync(admissions, "utf8");
  assert.equal(admitted, "admitted\n");
  await assert.rejects(agent.call("must refuse before provider admission", {
    ...options, temporaryRoot: path.join(foreignRoot, ".tmp", "caller-supplied"),
  }), (error) => error.cause?.code === "TEMPORARY_PATH_OUTSIDE_PROJECT");
  assert.equal(fs.readFileSync(admissions, "utf8"), admitted);
  assert.deepEqual(fs.readdirSync(foreignRoot), ["sentinel"]);
  assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
});
