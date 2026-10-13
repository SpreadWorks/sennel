/**
 * src/docs/commands/build.js
 *
 * sennel docs build — full documentation generation pipeline.
 * Orchestrates scan → enrich → init → data → text → readme → agents → [translate]
 * by invoking each pipeline step's Command class via the unified Command contract
 * (`cmd.run(container, input)`).
 */

import { stat, readdir } from "node:fs/promises";
import path from "path";
import { pathToFileURL } from "node:url";
import { PKG_DIR } from "../../lib/cli.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { Command } from "../../lib/command.js";
import { runDocumentationAiCommand, rethrowDocumentationAiStop } from "../lib/documentation-ai-execution.js";
import { EXIT_ERROR } from "../../lib/constants.js";
import { ExecutionMode, WritePlan } from "../../lib/execution-plan.js";
import { PRODUCT } from "../../lib/product.js";

import { validatePresetChain } from "../../lib/presets.js";
import DocsScanCommand, { prepareDocumentationScan } from "./scan.js";
import DocsEnrichCommand from "./enrich.js";
import DocsInitCommand from "./init.js";
import DocsDataCommand from "./data.js";
import DocsTextCommand from "./text.js";
import DocsReadmeCommand from "./readme.js";
import DocsAgentsCommand from "./agents.js";
import DocsTranslateCommand from "./translate.js";

const VALID_BUILD_FLAGS = new Set(["-h", "--help", "--verbose", "--dry-run", "--force", "--regenerate", "--yes"]);

async function dirExists(p) {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function validateBuildArgs(rawArgs) {
  for (const a of rawArgs) {
    if (a.startsWith("-") && !VALID_BUILD_FLAGS.has(a)) {
      const error = new Error(`sennel docs build: unknown option '${a}'`);
      error.exitCode = EXIT_ERROR;
      throw error;
    }
  }
}

async function runBuild(rawArgs, container) {
  validateBuildArgs(rawArgs);
  if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
    const { translate } = await import(pathToFileURL(path.join(PKG_DIR, "lib/i18n.js")).href);
    const t = translate();
    const h = t.raw("ui:help.cmdHelp.build");
    const o = h.options;
    console.log([
      h.usage, "", `  ${h.desc}`, `  ${h.descDetail}`, "", "Options:",
      `  ${t("ui:docsAi.yes")}`,
      `  ${o.agent}`, `  ${o.force}`, `  ${o.dryRun}`, `  ${o.verbose}`, `  ${o.help}`,
    ].join("\n"));
    return;
  }

  const baseCtx = resolveDocsContext(container, null, {
    dryRun: rawArgs.includes("--dry-run"),
    yes: rawArgs.includes("--yes"),
  });
  return runDocumentationAiCommand(baseCtx, rawArgs, "docs.build", () => executeBuild(rawArgs, container, baseCtx));
}

async function executeBuild(rawArgs, container, baseCtx) {
  const isVerbose = rawArgs.includes("--verbose");
  const isDryRun = baseCtx.dryRun;
  const hasForce = rawArgs.includes("--force");
  const hasRegenerate = rawArgs.includes("--regenerate");

  // Fail-fast: chapters ↔ templates static integrity check (spec 218).
  // Runs before any heavy processing (scan/enrich/etc).
  if (baseCtx.type) {
    validatePresetChain(baseCtx.type, baseCtx.root, {
      languages: baseCtx.config.docs?.languages || [],
      configChapters: baseCtx.config.chapters,
    });
  }

  const docsCfg = baseCtx.config.docs;
  const docsMode = docsCfg.mode || "translate";
  const isMultiLang = docsCfg.languages.length >= 2;
  const hasTranslateStep = isMultiLang;

  const pipelineSteps = [
    { label: "scan", weight: 1 },
    { label: "enrich", weight: 2 },
    ...(!hasRegenerate ? [{ label: "init", weight: 1 }] : []),
    { label: "data", weight: 1 },
    { label: "text", weight: 3 },
    { label: "readme", weight: 1 },
    { label: "agents", weight: 1 },
    ...(hasTranslateStep ? [{ label: "translate", weight: 2 }] : []),
  ];

  if (isDryRun) {
    const prepared = await prepareDocumentationScan(baseCtx);
    if (baseCtx.agent.resolve("docs.enrich")) {
      await new DocsEnrichCommand().run(container, {
        docsCtx: { ...baseCtx, preparedAnalysis: prepared.analysis, commandId: "docs.enrich" },
        _rawArgs: [],
      });
    }
    for (const step of pipelineSteps) {
      if (step.label !== "scan" && step.label !== "enrich") baseCtx.aiSession.markUnknownPhase(`docs.${step.label}`);
    }
  }

  const plan = new WritePlan("run docs build pipeline", {
    preview: pipelineSteps.map((step) => `  - ${step.label}`).join("\n"),
  });
  plan.add("execute each pipeline step and commit its generated files", async () => {
    const { createProgress } = await import(pathToFileURL(path.join(PKG_DIR, "lib/progress.js")).href);
    const progress = createProgress(pipelineSteps, {
      verbose: isVerbose,
      title: `Generating docs with ${PRODUCT.displayName}...`,
    });

    const logger = container.get("logger");
    const hasAgent = !!baseCtx.config.agent?.default;

    // Common contract invocation: each step runs via Command.run(container, input)
    // with `docsCtx` inside input so the leaf's execute() receives it as ctx.docsCtx.
    const runStep = async (CommandClass, stepCtx) => {
      const cmd = new CommandClass();
      return cmd.run(container, { docsCtx: stepCtx, _rawArgs: [] });
    };

    try {
      logger.event("pipeline-step", { step: "scan", phase: "start" });
      progress.start("scan");
      await runStep(DocsScanCommand, { ...baseCtx });
      progress.stepDone();

      logger.event("pipeline-step", { step: "enrich", phase: "start" });
      progress.start("enrich");
      if (hasAgent) {
        await runStep(DocsEnrichCommand, { ...baseCtx, commandId: "docs.enrich" });
      } else {
        progress.log("[enrich] WARN: no defaultAgent configured, skipping enrich.");
      }
      progress.stepDone();

      if (hasRegenerate) {
        let docsFiles = [];
        try {
          const entries = await readdir(baseCtx.docsDir);
          docsFiles = entries.filter((f) => f.endsWith(".md"));
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        if (docsFiles.length === 0) {
          const error = new Error("docs/ に章ファイルがありません。先に docs build を実行してください。");
          error.exitCode = EXIT_ERROR;
          throw error;
        }
      } else {
        logger.event("pipeline-step", { step: "init", phase: "start" });
        progress.start("init");
        await runStep(DocsInitCommand, { ...baseCtx, force: hasForce, dryRun: isDryRun, commandId: "docs.init" });
        progress.stepDone();
      }

      logger.event("pipeline-step", { step: "data", phase: "start" });
      progress.start("data");
      await runStep(DocsDataCommand, { ...baseCtx, dryRun: isDryRun });
      progress.stepDone();

      logger.event("pipeline-step", { step: "text", phase: "start" });
      progress.start("text");
      if (hasAgent) {
        const textResult = await runStep(DocsTextCommand, { ...baseCtx, dryRun: isDryRun, commandId: "docs.text", force: hasForce });
        if (textResult?.errors?.length > 0) {
          baseCtx.aiSession.markPartialError();
          progress.log(`[text] WARN: ${textResult.errors.length} file(s) had errors. Pipeline continues but docs may be incomplete.`);
        }
      } else {
        progress.log("[text] WARN: no defaultAgent configured, skipping text generation.");
      }
      progress.stepDone();

      logger.event("pipeline-step", { step: "readme", phase: "start" });
      progress.start("readme");
      await runStep(DocsReadmeCommand, { ...baseCtx, dryRun: isDryRun, commandId: "docs.readme" });
      progress.stepDone();

      logger.event("pipeline-step", { step: "agents", phase: "start" });
      progress.start("agents");
      await runStep(DocsAgentsCommand, { ...baseCtx, dryRun: isDryRun, commandId: "docs.agents" });
      progress.stepDone();

      if (isMultiLang) {
        logger.event("pipeline-step", { step: "translate", phase: "start" });
        progress.start("translate");
        const nonDefaultLangs = docsCfg.languages.filter((l) => l !== docsCfg.defaultLanguage);
        const docsDir = baseCtx.docsDir;

        if (docsMode === "translate") {
          progress.log(`[build] Translating to: ${nonDefaultLangs.join(", ")}`);
          await runStep(DocsTranslateCommand, { ...baseCtx, dryRun: isDryRun, commandId: "docs.translate" });
        } else {
          for (const lang of nonDefaultLangs) {
            const langDocsDir = path.join(docsDir, lang);
            const langCtx = { ...baseCtx, outputLang: lang, docsDir: langDocsDir };
            progress.log(`[build] Generating ${lang}...`);

            if (!hasRegenerate) {
              await runStep(DocsInitCommand, { ...langCtx, force: hasForce, dryRun: isDryRun, commandId: "docs.init" });
            }
            await runStep(DocsDataCommand, { ...langCtx, dryRun: isDryRun });
            if (hasAgent) {
              const langTextResult = await runStep(DocsTextCommand, { ...langCtx, dryRun: isDryRun, commandId: "docs.text", force: hasForce || hasRegenerate });
              if (langTextResult?.errors?.length > 0) {
                baseCtx.aiSession.markPartialError();
                progress.log(`[text] WARN: ${lang}: ${langTextResult.errors.length} file(s) had errors.`);
              }
            }
            const langReadmePath = path.join(langDocsDir, "README.md");
            await runStep(DocsReadmeCommand, { ...langCtx, dryRun: isDryRun, output: langReadmePath, commandId: "docs.readme" });
          }
        }

        if (docsMode === "translate") {
          for (const lang of nonDefaultLangs) {
            const langDocsDir = path.join(docsDir, lang);
            if (await dirExists(langDocsDir)) {
              const langReadmePath = path.join(langDocsDir, "README.md");
              progress.log(`[build] Regenerating ${lang}/README.md...`);
              await runStep(DocsReadmeCommand, { ...baseCtx, outputLang: lang, docsDir: langDocsDir, dryRun: isDryRun, output: langReadmePath, commandId: "docs.readme" });
            }
          }
        }

        progress.log("[build] Resolving lang.links...");
        await runStep(DocsDataCommand, { ...baseCtx, dryRun: isDryRun });
        for (const lang of nonDefaultLangs) {
          const langDocsDir = path.join(docsDir, lang);
          if (await dirExists(langDocsDir)) {
            await runStep(DocsDataCommand, { ...baseCtx, docsDir: langDocsDir, dryRun: isDryRun });
          }
        }
        progress.stepDone();
      }

      progress.done();
    } catch (err) {
      progress.done();
      logger.event("error", { message: err.message });
      rethrowDocumentationAiStop(err, baseCtx.aiSession);
      throw err;
    }
  });

  return ExecutionMode.fromDryRun(isDryRun).execute(plan);
}

export { runBuild };

export default class DocsBuildCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runBuild(ctx._rawArgs || [], ctx.container);
  }
}
