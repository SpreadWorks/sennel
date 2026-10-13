#!/usr/bin/env node
/**
 * sennel/engine/readme.js
 *
 * docs/ 配下の章ファイルから README.md を自動生成する。
 * 既存 README.md の MANUAL ブロックは保持する。
 *
 * Usage:
 *   node sennel/engine/readme.js [--dry-run] [--help]
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "../../lib/cli.js";
import { resolveTemplates, mergeResolved, resolveChaptersOrder, translateTemplate } from "../lib/template-merger.js";
import { createResolver } from "../lib/resolver-factory.js";
import { resolveDataDirectives, stripBlockDirectives, parseDirectives } from "../lib/directive-parser.js";
import { createLogger } from "../../lib/progress.js";
import { loadFullAnalysis } from "../lib/command-context.js";
import { processTemplate } from "./text.js";
import { buildTextSystemPrompt } from "../lib/text-prompts.js";
import { managedOutputDir } from "../../lib/config.js";
import { container } from "../../lib/container.js";
import { PRODUCT } from "../../lib/product.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { Command } from "../../lib/command.js";
import { runDocumentationAiCommand, rethrowDocumentationAiStop } from "../lib/documentation-ai-execution.js";

const logger = createLogger("readme");

// ---------------------------------------------------------------------------
// docs/ 解析 (removed — now handled by DocsSource DataSource)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// テンプレート処理 ({{data}} ディレクティブ解決)
// ---------------------------------------------------------------------------

// resolveDataDirectives is now imported from directive-parser.js

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function runReadme(ctx, rawArgs = [], commandContainer = container) {
  // CLI モード: 引数をパースしてコンテキストを構築
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--yes", "--dry-run"],
      options: ["--lang", "--output"],
      defaults: { lang: "", output: "" },
    });

    if (cli.help) {
      const { translate: tr } = await import("../../lib/i18n.js");
      const t = tr();
      const h = t.raw("ui:help.cmdHelp.readme");
      const o = h.options;
      console.log([h.usage, "", `  ${h.desc}`, "", "Options:", `  ${t("ui:docsAi.yes")}`, `  ${o.lang}`, `  ${o.output}`, `  ${o.dryRun}`, `  ${o.help}`].join("\n"));
      return;
    }

    ctx = resolveDocsContext(commandContainer, cli);
    ctx.dryRun = cli.dryRun;
    ctx.output = cli.output;
  }

  ctx.container ||= commandContainer;
  return runDocumentationAiCommand(ctx, rawArgs, "docs.readme", () => executeReadme(ctx));
}

async function executeReadme(ctx) {
  const { root, config, outputLang: lang, type, t } = ctx;

  if (!type) {
    console.log(t("messages:readme.noType"));
    return;
  }

  const projectLocalDir = path.join(root, PRODUCT.managedPath("templates", lang, "docs"));
  const docsConfig = config?.docs;
  const fallbackLangs = docsConfig?.languages?.filter((l) => l !== lang) || [];

  // ボトムアップでテンプレート解決
  const configChapters = config?.chapters;
  const chaptersOrder = resolveChaptersOrder(type, configChapters, root);
  const resolutions = resolveTemplates(type, lang, {
    projectLocalDir,
    fallbackLangs,
    chaptersOrder,
    projectRoot: root,
  });

  const readmeRes = resolutions.find((r) => r.fileName === "README.md");
  if (!readmeRes) {
    logger.log(t("messages:readme.noTemplate", { type }));
    return;
  }

  let merged = mergeResolved(readmeRes.sources);
  if (!merged) {
    logger.log(t("messages:readme.noTemplate", { type }));
    return;
  }

  const selectedReadmePath = ctx.output ? path.resolve(root, ctx.output) : path.join(root, "README.md");
  ctx.aiSession.registerFiles("docs.readme", [selectedReadmePath]);
  ctx.aiSession.registerInputs([selectedReadmePath, path.join(managedOutputDir(root), "analysis.json"), ...readmeRes.sources.map((source) => source.path)]);

  // フォールバック翻訳が必要な場合
  if (readmeRes.action === "translate") {
    const agent = ctx.agent;
    if (agent) {
      merged = await translateTemplate(merged, readmeRes.from, readmeRes.to, agent, root);
    }
  }

  // マージ後のブロックディレクティブを除去
  const templateContent = stripBlockDirectives(merged)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([^\n])\n(## )/g, "$1\n\n$2")
    .replace(/([^\n])\n(### )/g, "$1\n\n$2");

  // {{data}} ディレクティブを解決
  // 非デフォルト言語の場合は docsDir を指定して chapters() が正しいディレクトリを参照するようにする
  const readmeOutputPath = ctx.output ? selectedReadmePath : null;
  const resolverDocsDir = readmeOutputPath ? path.dirname(readmeOutputPath) : undefined;
  const readmePath = selectedReadmePath;
  let resolveFn;
  try {
    const resolver = await createResolver(type, root, {
      docsDir: resolverDocsDir,
      documentPath: readmePath,
      configChapters: config?.chapters,
    });
    resolveFn = resolver.resolve.bind(resolver);
  } catch (err) {
    logger.log(`resolver error: ${err.message}`);
    return;
  }

  const readmeRelPath = path.relative(root, readmePath).replace(/\\/g, "/");

  const resolveResult = resolveDataDirectives(
    templateContent,
    (preset, source, method, labels, params) => {
      if (source === "docs" && method === "langSwitcher") {
        return resolveFn(preset, source, method, {}, [labels[0] || "relative", readmeRelPath], params);
      }
      return resolveFn(preset, source, method, {}, labels, params);
    },
  );
  let resolved = resolveResult.text;

  // {{text}} ディレクティブを処理（per-directive モード）
  // README.md は {{data}} 解決済みの大きなコンテンツを含むため、
  // バッチモードでは AI が構造を維持できず充填に失敗する。
  // per-directive モードで各ディレクティブを個別に処理する。
  const textDirectives = parseDirectives(resolved).filter((d) => d.type === "text");
  if (ctx.dryRun && readmeRes.action === "translate" && textDirectives.length > 0) {
    ctx.aiSession.markUnknownPhase("docs.readme.text");
  } else if (textDirectives.length > 0) {
    try {
      const cfg = ctx.config;
      const agent = ctx.agent;
      if (!agent || !agent.resolve("docs.readme")) {
        throw new Error("No agent configured. Set 'agent.default' in config.json or run 'sennel setup'.");
      }
      const analysis = loadFullAnalysis(root) || {};
      const documentStyle = cfg?.docs?.style;
      const systemPrompt = buildTextSystemPrompt(documentStyle, lang);

      const result = await processTemplate(
        resolved, analysis, "README.md", agent,
        ctx.dryRun, [], systemPrompt, undefined, undefined, lang, ctx.srcRoot || root,
      );
      if (result.filled > 0) {
        resolved = result.text;
        logger.log(`${result.filled} text directive(s) filled in README.`);
      }
    } catch (err) {
      rethrowDocumentationAiStop(err, ctx.aiSession);
      ctx.aiSession.markPartialError();
      logger.log(`WARN: skipping {{text}} in README: ${err.message}`);
    }
  }

  const newContent = resolved.endsWith("\n") ? resolved : resolved + "\n";

  // 差分チェック
  if (fs.existsSync(readmePath)) {
    const current = fs.readFileSync(readmePath, "utf8");
    if (current === newContent) {
      logger.log(t("messages:readme.noChanges"));
      return;
    }
  }

  if (ctx.dryRun) {
    logger.log(t("messages:readme.dryRun"));
    console.log("---");
    console.log(newContent);
    return;
  }

  ctx.aiSession.assertActive();
  fs.writeFileSync(readmePath, newContent, "utf8");
  ctx.aiSession.recordGeneratedFiles([readmePath]);
  logger.log(t("messages:readme.updated"));
}

export default class DocsReadmeCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runReadme(ctx.docsCtx, ctx._rawArgs || [], ctx.container);
  }
}
