import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { Logger } from "../../src/lib/log.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../src/lib/flow-target-guard.js";
import { runGit } from "../../src/lib/git-helpers.js";
import { SpecGateRepairProgressReader } from "../../src/flow/lib/spec-gate-repair-progress-reader.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import { createSpecGateRepairScenario } from "../support/infrastructure/spec-gate-repair-scenario.js";
import { dispatchContainer } from "../support/infrastructure/flow-dispatch-scenario.js";
import { initGitRepo, commitAll } from "../support/infrastructure/git-repo.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../support/builders/tmp-dir.js";

const CLI = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));
const entryOrigin = "src/collections/entry.js";
const ownerOrigin = "src/collections/limits.js";
const scopedRuleOrigin = "src/collections/AGENTS.md";
const entryText = "import { maximumItems } from './limits.js';\nexport const permits = items => items.length <= maximumItems;\n";
const committedOwner = "export const maximumItems = 137;\n";
const activeOwner = "export const maximumItems = 239;\n";
const scopedRules = "For collection limit requirements, read the imported owner in the active checkout and include its exact decimal maximumItems value. Include the literal provenance phrase 'checkout-limit-witness' in the repaired requirement. Source files and all AGENTS.md files are read-only.\n";

// Unlike deterministic provider fixtures, this scenario verifies the external
// CLI's actual checkout research and seal through the production dispatcher.
test("real Gate repair worker follows imports and scoped rules in the active checkout", { timeout: 600_000 }, async (t) => {
  const model = process.env.SENNEL_GATE_QUALITY_MODEL || "gpt-6-luna";
  const providerKey = `codex/${model}`;
  const config = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    agent: { default: providerKey, useProfile: process.env.SENNEL_AGENT_TEST_PROFILE || "source-research",
      timeout: 480, retryCount: 1, promptCharacterLimit: 60_000,
      profiles: { "source-research": { "flow.dispatch": providerKey } },
      providers: { [providerKey]: { command: "codex",
        args: ["exec", "--json", "--sandbox", "workspace-write", "-m", model, "{{PROMPT}}"],
        jsonOutputFlag: "--json", jsonSchemaFlag: "--output-schema", jsonSchemaMode: "file" } } } };
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements[0].desc = "Reject collections exceeding 137 items.";
  const value = await createSpecGateRepairScenario({ specId: "500-real-source-research", specRecord,
    request: `Correct the collection limit requirement using ${entryOrigin} and its imported contract in the active checkout. Follow applicable project rules, preserve source files, and seal only the authorized repair payload.`,
    mutateGateObservations: (observations) => observations.map((observation) => ({ ...observation,
      observed: `The stated maximum is stale. Read ${entryOrigin}, follow its import to the owner, and use the active checkout value and applicable scoped rules to correct this requirement.` })),
    beforeGate: ({ root }) => {
      fs.mkdirSync(path.join(root, "src/collections"), { recursive: true });
      fs.writeFileSync(path.join(root, entryOrigin), entryText);
      fs.writeFileSync(path.join(root, ownerOrigin), committedOwner);
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Read the applicable scoped AGENTS.md when investigating implementation. Source and rule files are read-only; write only authorized worker payloads.\n");
      fs.writeFileSync(path.join(root, scopedRuleOrigin), scopedRules);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n.test-bin/\nspecs/\n");
      initGitRepo(root);
      commitAll(root, "Create imported contract and scoped research rules");
      fs.writeFileSync(path.join(root, ownerOrigin), activeOwner);
    } });
  t.after(() => removeTmpDir(value.root));
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  fs.writeFileSync(path.join(value.root, ".sennel/config.json"), workerArtifactJson(config));
  const bin = path.join(value.root, ".test-bin");
  fs.mkdirSync(bin);
  // Point the ordinary seal command at this checkout's CLI, without depending
  // on an installed package's revision or changing any runtime contract.
  fs.writeFileSync(path.join(bin, "sennel"), `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const beforeCode = new Map(["AGENTS.md", scopedRuleOrigin, entryOrigin, ownerOrigin]
    .map((origin) => [origin, fs.readFileSync(path.join(value.root, origin))]));
  const beforeStatus = runGit(["status", "--porcelain"], { cwd: value.root });
  assert.equal(beforeStatus.ok, true);
  assert.equal(beforeStatus.stdout.trim(), `M ${ownerOrigin}`, "the imported owner differs from committed HEAD");
  const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
  const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: path.join(value.root, ".tmp/logs"), enabled: false }), flowManager: value.flowManager });
  const flowState = value.flowManager.loadReadOnly(value.specId);
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
  t.diagnostic(`Actual flow.dispatch provider: ${agent.resolve("flow.dispatch").profileKey}`);
  const result = await dispatcher.execute({ ...value.ctx, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" });
  const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  assert.equal(reloaded.canonicalState(value.specId).nextAction().nodeId, "spec-review", JSON.stringify(result));
  const stored = JSON.parse(reloaded.readArtifact({ specId: value.specId,
    logicalKey: "spec.record", consumerNodeId: "spec-review" }).bytes);
  assert.match(stored.requirements[0].desc, /\b239\b/, "repair uses the uncommitted imported owner's actual limit");
  assert.doesNotMatch(stored.requirements[0].desc, /\b137\b/, "repair replaces the stale committed limit");
  assert.match(stored.requirements[0].desc, /checkout-limit-witness/, "the uncaptured scoped rule controls provenance wording");
  const claimed = new SpecGateRepairProgressReader({ flowManager: reloaded, specId: value.specId,
    attemptId, consumerNodeId: "spec-gate-repair" }).read(0, "claimed");
  assert.equal(claimed.sourceSnapshots.sources().some((source) => source.origin.endsWith(".js")), false);
  assert.equal(claimed.sourceSnapshots.sources().some((source) => source.origin === scopedRuleOrigin), false);
  for (const [origin, bytes] of beforeCode) assert.deepEqual(fs.readFileSync(path.join(value.root, origin)), bytes, origin);
  const afterStatus = runGit(["status", "--porcelain"], { cwd: value.root });
  assert.equal(afterStatus.ok, true);
  assert.equal(afterStatus.stdout, beforeStatus.stdout, "the research worker preserves source and Git state");
});
