import { testTemporaryRoot } from "../../test-environment.js";
/**
 * tests/acceptance/lib/pipeline.js
 *
 * Runs the sennel pipeline (scan → enrich → init → data → text → readme)
 * against a fixture project by instantiating each pipeline step's Command
 * class and invoking `cmd.run(container, { docsCtx, _rawArgs: [] })`.
 */

import fs from "fs";
import path from "path";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { validate, loadJsonFile } from "../../../src/lib/config.js";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { createI18n } from "../../../src/lib/i18n.js";
import { Container } from "../../../src/lib/container.js";

import DocsScanCommand from "../../../src/docs/commands/scan.js";
import DocsEnrichCommand from "../../../src/docs/commands/enrich.js";
import DocsInitCommand from "../../../src/docs/commands/init.js";
import DocsDataCommand from "../../../src/docs/commands/data.js";
import DocsTextCommand from "../../../src/docs/commands/text.js";
import DocsReadmeCommand from "../../../src/docs/commands/readme.js";

export function copyFixtureInto(fixtureDir, dest, configOverrides) {
  copyDirSync(fixtureDir, dest);

  if (configOverrides) {
    const configPath = path.join(dest, ".sennel", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    Object.assign(config, configOverrides);
    if (configOverrides.agent === null) delete config.agent;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  fs.mkdirSync(path.join(dest, ".sennel", "output"), { recursive: true });
  fs.mkdirSync(path.join(dest, "docs"), { recursive: true });

  return dest;
}

/**
 * Copy a fixture directory to a temporary directory.
 *
 * @param {string} fixtureDir - Absolute path to fixture
 * @param {Object} [configOverrides] - Fields to merge into config.json
 * @returns {string} Absolute path to tmp dir
 */
export function copyFixture(fixtureDir, configOverrides) {
  const workRoot = new SeedWorkRoot(fixtureDir, { prefix: "sennel-acceptance-" });
  if (configOverrides) {
    const configPath = path.join(workRoot.root, ".sennel", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    Object.assign(config, configOverrides);
    if (configOverrides.agent === null) delete config.agent;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  fs.mkdirSync(path.join(workRoot.root, ".sennel", "output"), { recursive: true });
  fs.mkdirSync(path.join(workRoot.root, "docs"), { recursive: true });
  return workRoot.root;
}

/**
 * Build a docs command context object and an isolated Container scoped to the
 * fixture tmp directory. The Container is populated with config/paths/agent/
 * i18n/logger so Command subclasses that read from the container at runtime
 * still see fixture-scoped values.
 */
export function buildCtx(tmp, { agent: injectedAgent = null } = {}) {
  const configPath = path.join(tmp, ".sennel", "config.json");
  const config = validate(loadJsonFile(configPath));
  const lang = config.lang || "en";
  const outputLang = config.docs?.defaultLanguage || lang;
  const type = config.type || "base";
  const docsDir = path.join(tmp, "docs");
  const registry = new ProviderRegistry(config?.agent?.providers || {});
  const paths = { root: tmp, srcRoot: tmp, agentWorkDir: path.join(tmp, ".tmp") };
  const logger = new Logger({ logDir: testTemporaryRoot().path, enabled: false });
  const agentService = injectedAgent || new Agent({ config, paths, registry, logger });
  const agent = agentService.resolve() ? agentService : null;
  const t = createI18n(lang, { domain: "messages" });

  const container = new Container();
  container.register("root", tmp);
  container.register("config", config);
  container.register("paths", paths);
  container.register("logger", logger);
  container.register("agent", agentService);
  container.register("i18n", t);
  container.register("lang", lang);

  const ctx = {
    root: tmp,
    srcRoot: tmp,
    config,
    lang,
    outputLang,
    type,
    docsDir,
    agent,
    t,
  };

  return { ctx, container };
}

// Agent infrastructure error patterns. Errors matching these are classified
// as `agent-error` status (distinct from `error`, which is test-logic failure).
const AGENT_ERROR_PATTERNS = [
  /empty (batch )?response/i,
  /agent output parse failed/i,
  /Reading prompt from stdin/i,
  /stdin=(EPIPE|ENOTCONN)/,
  /exit=\d+.*agent/i,
  /docs quality check/i,
];

function classifyStepError(err) {
  if (err?.agentError) return "agent-error";
  const msg = String(err?.message || err);
  return AGENT_ERROR_PATTERNS.some((re) => re.test(msg)) ? "agent-error" : "error";
}

async function runStep(name, CommandClass, container, docsCtx) {
  const start = performance.now();
  try {
    const cmd = new CommandClass();
    await cmd.run(container, { docsCtx, _rawArgs: [] });
    const durationMs = Math.round(performance.now() - start);
    console.log(`  [pipeline] ${name}: ok (${durationMs}ms)`);
    return { name, status: "ok", durationMs };
  } catch (e) {
    const durationMs = Math.round(performance.now() - start);
    const status = classifyStepError(e);
    console.error(`  [pipeline] ${name}: ${status} (${durationMs}ms) — ${e.message}`);
    throw Object.assign(e, { stepResult: { name, status, durationMs } });
  }
}

export async function runPipeline(tmp, { agent = null } = {}) {
  const { ctx, container } = buildCtx(tmp, { agent });
  const steps = [];

  steps.push(await runStep("scan", DocsScanCommand, container, { ...ctx }));

  if (ctx.agent) {
    try {
      steps.push(await runStep("enrich", DocsEnrichCommand, container, {
        ...ctx,
        commandId: "docs.enrich",
      }));
    } catch (e) {
      steps.push(e.stepResult);
      console.error(`[acceptance] enrich warning: continuing without enrichment`);
    }
  } else {
    steps.push({ name: "enrich", status: "skipped", durationMs: 0 });
  }

  steps.push(await runStep("init", DocsInitCommand, container, { ...ctx, force: true }));

  steps.push(await runStep("data", DocsDataCommand, container, { ...ctx }));

  if (ctx.agent) {
    try {
      steps.push(await runStep("text", DocsTextCommand, container, {
        ...ctx,
        commandId: "docs.text",
      }));
    } catch (e) {
      steps.push(e.stepResult);
      if (e.stepResult.status !== "agent-error") throw e;
      console.error(`[acceptance] text warning: agent-infra error, continuing`);
    }
  } else {
    steps.push({ name: "text", status: "skipped", durationMs: 0 });
  }

  steps.push(await runStep("readme", DocsReadmeCommand, container, { ...ctx }));

  return { ctx, steps };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export { removeTmpDir };
