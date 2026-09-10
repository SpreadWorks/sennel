#!/usr/bin/env node
/**
 * sennel/engine/init.js
 *
 * テンプレート継承チェーンをもとにテンプレートをマージし docs/ に出力する。
 *
 * Usage:
 *   node sennel/engine/init.js [--type php-mvc] [--force]
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "../../lib/cli.js";
import { Command } from "../../lib/command.js";
import { loadPackageField, resolvePromptCharacterLimit } from "../../lib/config.js";
import { resolveTemplates, mergeResolved, resolveChaptersOrder, translateTemplate } from "../lib/template-merger.js";
import { summaryToText } from "../lib/forge-prompts.js";
import { createLogger } from "../../lib/progress.js";
import { translate } from "../../lib/i18n.js";
import { loadFullAnalysis, loadAnalysisData } from "../lib/command-context.js";
import { stripBlockDirectives } from "../lib/directive-parser.js";
import { container } from "../../lib/container.js";
import { PRODUCT } from "../../lib/product.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { ExecutionMode, WritePlan } from "../../lib/execution-plan.js";
import { selectDocumentationChapters } from "../lib/documentation-init-batching.js";

const logger = createLogger("init");

class InitChapterPlan {
  constructor(resolution, content) {
    if (!resolution?.fileName || typeof content !== "string") {
      throw new Error("InitChapterPlan requires a template resolution and content");
    }
    this.resolution = resolution;
    this.fileName = resolution.fileName;
    this.content = content;
    Object.freeze(this);
  }

  async render(agent, root, maxCharacters) {
    if (this.resolution.action !== "translate" || !agent) return this.content;
    return translateTemplate(
      this.content,
      this.resolution.from,
      this.resolution.to,
      agent,
      root,
      { maxCharacters },
    );
  }
}

// ---------------------------------------------------------------------------
// AI 章選別
// ---------------------------------------------------------------------------

/**
 * AI エージェントで章の取捨選択を行う。
 *
 * @param {{ fileName: string, content: string }[]} chapters
 * @param {Object} analysis
 * @param {Object} agent - エージェント設定
 * @param {string} root
 * @param {string} purpose - documentStyle.purpose
 * @returns {{ fileName: string, content: string }[]}
 */
async function aiFilterChapters(chapters, analysis, agent, _root, purpose, maxCharacters) {
  const summary = summaryToText(analysis);
  let selectedSet;
  try {
    selectedSet = await selectDocumentationChapters({
      chapters,
      analysisText: summary,
      purpose,
      agent,
      maxCharacters,
    });
  } catch (err) {
    logger.log(`[init] WARN: AI chapter selection failed: ${err.message}`);
    return chapters;
  }
  const filtered = chapters.filter((ch) => selectedSet.has(ch.fileName));

  if (filtered.length === 0) {
    logger.log("[init] WARN: AI selected 0 chapters, ignoring AI filter.");
    return chapters;
  }

  const removed = chapters.filter((ch) => !selectedSet.has(ch.fileName));
  if (removed.length > 0) {
    logger.verbose(`AI filter removed: ${removed.map((ch) => ch.fileName).join(", ")}`);
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------
async function runInit(ctx, rawArgs) {
  // CLI モード: 引数をパースしてコンテキストを構築
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--force", "--dry-run"],
      options: ["--type", "--lang", "--docs-dir"],
      defaults: { type: "", force: false, dryRun: false, lang: "", docsDir: "" },
    });
    if (cli.help) {
      const tu = translate();
      const h = tu.raw("ui:help.cmdHelp.init");
      const o = h.options;
      console.log([h.usage, "", h.desc, "", "Options:", `  ${o.type}`, `  ${o.force}`, `  ${o.dryRun}`, `  ${o.help}`].join("\n"));
      return;
    }
    ctx = resolveDocsContext(container, cli, { commandId: "docs.init" });
    ctx.force = cli.force;
    ctx.dryRun = cli.dryRun;
  }

  const { root, config, outputLang: lang, docsDir, agent, t } = ctx;
  const promptCharacterLimit = resolvePromptCharacterLimit(config);

  let type = ctx.type;
  if (!type) {
    const defaults = loadPackageField(root, "docsInit") || {};
    const rawType = config?.type || defaults.defaultType;
    if (!rawType) {
      throw new Error(t("messages:init.noType"));
    }
    type = rawType;
  }

  logger.verbose(`type=${type} lang=${lang}`);

  // テンプレート解決（ボトムアップ方式）
  const projectLocalDir = path.join(root, PRODUCT.managedPath("templates", lang, "docs"));
  const docsConfig = config?.docs;
  const configLangs = docsConfig?.languages?.filter((l) => l !== lang) || [];
  // Always include "en" as ultimate fallback for presets with English-only templates
  const fallbackLangs = configLangs.includes("en") || lang === "en"
    ? configLangs
    : [...configLangs, "en"];
  const configChapters = config?.chapters;
  const chaptersOrder = resolveChaptersOrder(type, configChapters, root);

  const resolutions = resolveTemplates(type, lang, {
    projectLocalDir,
    fallbackLangs,
    chaptersOrder,
    projectRoot: root,
  });

  // Build the write plan from static template resolution. Agent-backed
  // translation and filtering belong to commit and are unreachable in dry-run.
  const plannedChapters = [];
  for (const res of resolutions) {
    if (res.fileName === "README.md") continue;
    const content = mergeResolved(res.sources, res.additive);
    if (content === null) continue;
    plannedChapters.push(new InitChapterPlan(res, content));
  }

  if (plannedChapters.length === 0) {
    throw new Error(t("messages:init.noTemplates"));
  }

  const preview = plannedChapters
    .map((chapter) => `  - ${path.join(docsDir, chapter.fileName)}`)
    .join("\n");
  const plan = new WritePlan(`initialize ${plannedChapters.length} documentation files`, {
    preview,
  });
  plan.add(`create ${docsDir} and write the selected documentation files`, async () => {
    const chapters = [];
    for (const planned of plannedChapters) {
      const content = await planned.render(agent, root, promptCharacterLimit);
      chapters.push({ fileName: planned.fileName, content });
    }

    // config.chapters is authoritative. Without it, the agent may select a
    // subset, but only during commit.
    let filteredChapters = chapters;
    const analysis = loadFullAnalysis(root);
    if (configChapters?.length) {
      logger.verbose("config.chapters defined — skipping AI chapter filter");
    } else if (analysis && agent) {
      logger.verbose("AI chapter selection...");
      const summaryData = loadAnalysisData(root);
      filteredChapters = await aiFilterChapters(
        filteredChapters,
        summaryData,
        agent,
        root,
        config?.docs?.style?.purpose || "",
        promptCharacterLimit,
      );
    }

    const totalFiltered = chapters.length - filteredChapters.length;
    logger.verbose(`${filteredChapters.length} template files (${totalFiltered} filtered by AI)`);

    fs.mkdirSync(docsDir, { recursive: true });
    const outputChapters = filteredChapters.map((ch) => ({ ...ch, outputName: ch.fileName }));
    const conflicts = outputChapters.filter((ch) => fs.existsSync(path.join(docsDir, ch.outputName)));
    const conflictSet = new Set(conflicts.map((ch) => ch.outputName));

    if (conflicts.length > 0 && !ctx.force) {
      logger.log(t("messages:init.conflictsExist", { count: conflicts.length }));
      for (const ch of conflicts) logger.log(`  - ${ch.outputName}`);
      logger.log(t("messages:init.useForce"));
    }
    if (conflicts.length > 0 && ctx.force) {
      logger.verbose(`--force: overwriting ${conflicts.length} existing file(s)`);
    }

    for (const chapter of outputChapters) {
      if (conflictSet.has(chapter.outputName) && !ctx.force) continue;
      const text = stripBlockDirectives(chapter.content);
      logger.verbose(`merged: ${chapter.fileName} → ${chapter.outputName}`);
      fs.writeFileSync(path.join(docsDir, chapter.outputName), text, "utf8");
    }

    logger.verbose(`done. ${outputChapters.length} files initialized in docs/`);
    return outputChapters;
  });

  return ExecutionMode.fromDryRun(ctx.dryRun).execute(plan);
}

export { aiFilterChapters };

export default class DocsInitCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runInit(ctx.docsCtx, ctx._rawArgs || []);
  }
}
