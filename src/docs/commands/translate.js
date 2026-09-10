#!/usr/bin/env node
/**
 * src/docs/commands/translate.js
 *
 * Translate default-language documents to non-default languages.
 * Compares mtime of source vs target file; re-translates only when needed.
 *
 * Usage:
 *   sennel docs translate [--dry-run] [--force] [--lang <lang>]
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "../../lib/cli.js";
import { resolveConcurrency, resolvePromptCharacterLimit } from "../../lib/config.js";
import { createLogger } from "../../lib/progress.js";
import { getChapterFiles } from "../lib/command-context.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { container } from "../../lib/container.js";
import { translateMarkdownWithBatches } from "../lib/markdown-prompt-document.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { Command } from "../../lib/command.js";
import { AtomicFile } from "../../lib/atomic-file.js";

const logger = createLogger("translate");

/**
 * Translate a Markdown document from one language to another via AI agent.
 *
 * @param {string} content - Source document content
 * @param {string} fromLang - Source language code
 * @param {string} toLang - Target language code
 * @param {Object} agent - Agent config
 * @param {string} root - Project root
 * @returns {Promise<string>} Translated content
 */
async function translateDocument(content, fromLang, toLang, agent, root, documentStyle, options = {}) {
  return translateMarkdownWithBatches({
    content,
    documentId: options.documentId || path.basename(root || "document"),
    fromLang,
    toLang,
    agent,
    commandId: "docs.translate",
    documentStyle,
    maxCharacters: options.maxCharacters,
    concurrency: options.concurrency,
  });
}

/**
 * Check if source file is newer than target file.
 */
function needsTranslation(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) return true;
  const srcMtime = fs.statSync(sourcePath).mtimeMs;
  const tgtMtime = fs.statSync(targetPath).mtimeMs;
  return srcMtime > tgtMtime;
}

/**
 * Build a flat list of translation tasks from lang × files.
 * Filters out up-to-date files (unless force is true).
 *
 * @param {Object} opts
 * @param {string[]} opts.sourceFiles - Chapter file names
 * @param {string[]} opts.targetLangs - Target language codes
 * @param {string} opts.docsDir - Docs directory path
 * @param {string} opts.readmePath - README.md path
 * @param {boolean} opts.hasReadme - Whether README.md exists
 * @param {boolean} opts.force - Force re-translation
 * @returns {Array<{lang: string, sourcePath: string, targetPath: string, label: string}>}
 */
function buildTranslationTasks({ sourceFiles, targetLangs, docsDir, readmePath, hasReadme, force }) {
  const tasks = [];
  for (const lang of targetLangs) {
    const langDir = path.join(docsDir, lang);
    for (const file of sourceFiles) {
      const sourcePath = path.join(docsDir, file);
      const targetPath = path.join(langDir, file);
      if (!force && !needsTranslation(sourcePath, targetPath)) continue;
      tasks.push({ lang, sourcePath, targetPath, label: `${file} → ${lang}/${file}` });
    }
    if (hasReadme) {
      const targetReadme = path.join(langDir, "README.md");
      if (force || needsTranslation(readmePath, targetReadme)) {
        tasks.push({ lang, sourcePath: readmePath, targetPath: targetReadme, label: `README.md → ${lang}/README.md` });
      }
    }
  }
  return tasks;
}

async function runTranslate(ctx, rawArgs) {
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--dry-run", "--force"],
      options: ["--lang"],
      defaults: { dryRun: false, force: false, lang: "" },
    });

    if (cli.help) {
      const { translate: tr } = await import("../../lib/i18n.js");
      const t = tr();
      const h = t.raw("ui:help.cmdHelp.translate");
      const o = h.options;
      console.log([h.usage, "", `  ${h.desc}`, "", "Options:", `  ${o.lang}`, `  ${o.force}`, `  ${o.dryRun}`, `  ${o.help}`].join("\n"));
      return;
    }

    ctx = resolveDocsContext(container, cli, { commandId: "docs.translate" });
    ctx.dryRun = cli.dryRun;
    ctx.force = cli.force;
    ctx.targetLang = cli.lang;
  }

  const { root, config: cfg, docsDir } = ctx;
  const docsCfg = cfg.docs;
  const docsMode = docsCfg.mode || "translate";

  if (docsCfg.languages.length < 2) {
    logger.log("Single language configured. Nothing to translate.");
    return;
  }

  if (docsMode !== "translate") {
    logger.log(`Output mode is '${docsMode}', not 'translate'. Use 'sennel docs build' for generate mode.`);
    return;
  }

  if (!ctx.agent) {
    throw new Error("No agent configured. Set 'defaultAgent' in config.json.");
  }
  const agent = ctx.agent;

  const defaultLang = docsCfg.defaultLanguage;
  const targetLangs = ctx.targetLang
    ? [ctx.targetLang]
    : docsCfg.languages.filter((l) => l !== defaultLang);

  if (!fs.existsSync(docsDir)) {
    throw new Error("docs/ directory not found. Run 'sennel docs init' first.");
  }

  const sourceFiles = getChapterFiles(docsDir, { type: ctx.type, configChapters: ctx.config?.chapters, projectRoot: root });
  const readmePath = path.join(root, "README.md");
  const hasReadme = fs.existsSync(readmePath);

  const tasks = buildTranslationTasks({ sourceFiles, targetLangs, docsDir, readmePath, hasReadme, force: ctx.force });

  if (ctx.dryRun) {
    for (const t of tasks) {
      logger.log(`DRY-RUN: would translate ${t.label}`);
    }
    logger.log(`Done. 0 file(s) translated, ${tasks.length} would be translated.`);
    return;
  }

  // Ensure all target language directories exist
  const langDirs = [...new Set(tasks.map((t) => t.lang))];
  for (const lang of langDirs) {
    fs.mkdirSync(path.join(docsDir, lang), { recursive: true });
  }

  const concurrency = resolveConcurrency(cfg);
  const maxCharacters = resolvePromptCharacterLimit(cfg);
  logger.log(`Translating ${tasks.length} file(s) (concurrency=${concurrency})...`);

  const results = await mapWithConcurrency(tasks, concurrency, async (task) => {
    logger.verbose(`Translating: ${task.label}`);
    const content = fs.readFileSync(task.sourcePath, "utf8");
    const translated = await translateDocument(content, defaultLang, task.lang, agent, root, cfg.docs?.style, {
      documentId: task.label,
      maxCharacters,
      concurrency: 1,
    });
    return { task, translated };
  });

  // Translation is planned completely before publication. A provider failure
  // must not leave successful sibling files updated on disk.
  results.throwIfErrors();
  for (const result of results) {
    const { task, translated } = result.value;
    new AtomicFile(task.targetPath).write(Buffer.from(translated, "utf8"));
    logger.verbose(`DONE: ${task.label}`);
  }
  const totalTranslated = results.length;

  const totalSkipped = (sourceFiles.length + (hasReadme ? 1 : 0)) * targetLangs.length - tasks.length;
  logger.log(`Done. ${totalTranslated} file(s) translated, ${totalSkipped} skipped.`);
}

export { buildTranslationTasks, translateDocument };

export default class DocsTranslateCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runTranslate(ctx.docsCtx, ctx._rawArgs || []);
  }
}
