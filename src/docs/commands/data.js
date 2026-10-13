#!/usr/bin/env node
/**
 * sennel/engine/populate.js
 *
 * ディレクティブベースのテンプレートエンジン。
 * analysis.json を読み、テンプレート内の {{data}} ディレクティブを解決してレンダリングする。
 * {{text}} はスキップしてログ出力する（後続タスクで LLM 連携を実装予定）。
 *
 * Usage:
 *   node sennel/engine/populate.js [--dry-run] [--stdout]
 */

import fs from "fs";
import path from "path";
import { resolveDataDirectives } from "../lib/directive-parser.js";
import { createResolver } from "../lib/resolver-factory.js";
import { parseArgs } from "../../lib/cli.js";
import { managedOutputDir } from "../../lib/config.js";
import { createLogger } from "../../lib/progress.js";
import { translate } from "../../lib/i18n.js";
import { getChapterFiles } from "../lib/command-context.js";
import { filterAnalysisByDocsExclude } from "../lib/analysis-filter.js";
import { container } from "../../lib/container.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { Command } from "../../lib/command.js";
import {
  DocumentUpdatePlan,
  DocumentUpdateTransaction,
  DocumentValidationResult,
} from "../lib/document-update-plan.js";

const logger = createLogger("data");

// ---------------------------------------------------------------------------
// テンプレートファイル処理
// ---------------------------------------------------------------------------

/**
 * 1 ファイルのディレクティブをすべて処理し、置換後のテキストを返す。
 *
 * @param {string} text     - テンプレート全文
 * @param {Object} analysis - analysis.json
 * @param {string} fileName - ログ出力用ファイル名
 * @param {function} [resolveFn] - (preset, source, method, analysis, labels) => rendered string
 * @returns {{ text: string, replaced: number, skipped: number }}
 */
function processTemplate(text, analysis, fileName, resolveFn) {
  if (!resolveFn) {
    throw new Error("resolveFn is required — run createResolver() first");
  }
  let skipped = 0;
  let unresolved = 0;

  const result = resolveDataDirectives(
    text,
    (preset, source, method, labels, params) => resolveFn(preset, source, method, analysis, labels, params),
    {
      onSkip(d) {
        if (d.type === "text") {
          skipped++;
          logger.verbose(`SKIP {{text}} in ${fileName}:${d.line + 1}: ${d.prompt.slice(0, 60)}...`);
        }
      },
      onUnresolved(d) {
        unresolved++;
        logger.log(`UNRESOLVED {{data}} in ${fileName}:${d.line + 1}: ${d.preset}.${d.source}.${d.method} → null`);
      },
    },
  );

  let out = result.text;
  if (!out.endsWith("\n")) out += "\n";
  return { text: out, replaced: result.replaced, skipped };
}

// ---------------------------------------------------------------------------
// populateFromAnalysis (エクスポート用: forge.js などから呼び出し可能)
// ---------------------------------------------------------------------------
export class DocumentationDataPreparation {
  constructor(docsDir, plans, files) {
    if (!plans.every((plan) => plan instanceof DocumentUpdatePlan)) throw new TypeError("Documentation data preparation requires document update plans");
    this.docsDir = docsDir;
    this.plans = Object.freeze(plans);
    this.files = Object.freeze(files);
    Object.freeze(this);
  }

  get populated() { return this.files.length > 0; }

  commit({ aiSession, faultInjector } = {}) {
    aiSession?.assertActive();
    new DocumentUpdateTransaction(this.plans, { faultInjector }).commit();
    aiSession?.recordGeneratedFiles(this.files.map((file) => path.join(this.docsDir, file)));
    return this;
  }
}

export function populateFromAnalysis(root, analysis, resolveFn, opts = {}) {
  const prepared = prepareDataPopulation(root, analysis, resolveFn, opts);
  return opts.dryRun ? prepared : prepared.commit(opts);
}

export function prepareDataPopulation(root, analysis, resolveFn, opts = {}) {
  const docsDir = path.join(root, "docs");
  const changedFiles = [];
  const plans = [];
  if (!analysis || !resolveFn) return new DocumentationDataPreparation(docsDir, plans, changedFiles);

  const docsFiles = getChapterFiles(docsDir, { type: opts?.type, configChapters: opts?.configChapters, projectRoot: root });

  for (const file of docsFiles) {
    const filePath = path.join(docsDir, file);
    const originalBytes = fs.readFileSync(filePath);
    const original = originalBytes.toString("utf8");
    const result = processTemplate(original, analysis, file, resolveFn);

    if (result.replaced > 0) {
      plans.push(new DocumentUpdatePlan({
        filePath,
        originalBytes,
        proposedBytes: Buffer.from(result.text),
        validationResult: DocumentValidationResult.accepted(),
      }));
      changedFiles.push(file);
    }
  }

  return new DocumentationDataPreparation(docsDir, plans, changedFiles);
}

// ---------------------------------------------------------------------------
// CLI メイン
// ---------------------------------------------------------------------------
async function runData(ctx, rawArgs) {
  // CLI モード: 引数をパースしてコンテキストを構築
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--dry-run", "--stdout"],
      options: ["--docs-dir"],
      defaults: { dryRun: false, stdout: false, docsDir: "" },
    });
    if (cli.help) {
      const t = translate();
      const h = t.raw("ui:help.cmdHelp.data");
      const o = h.options;
      console.log([h.usage, "", h.desc, "", "Options:", `  ${o.dryRun}`, `  ${o.stdout}`, `  ${o.help}`].join("\n"));
      return;
    }
    ctx = resolveDocsContext(container, cli);
    ctx.dryRun = cli.dryRun;
    ctx.stdout = cli.stdout;
  }

  const { root, type, docsDir, t } = ctx;

  const analysisPath = path.join(managedOutputDir(root), "analysis.json");

  if (!fs.existsSync(analysisPath)) {
    throw new Error(`${t("messages:data.analysisNotFound", { path: analysisPath })}\n${t("messages:data.runScanFirst")}`);
  }

  const rawAnalysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const docsExclude = ctx.config?.docs?.exclude;
  const analysis = filterAnalysisByDocsExclude(rawAnalysis, docsExclude);

  // type に基づくリゾルバを生成
  let resolveFn;
  try {
    const resolver = await createResolver(type, root, { docsDir, configChapters: ctx.config?.chapters });
    resolveFn = (preset, source, method, a, labels, params) => resolver.resolve(preset, source, method, a, labels, params);
    logger.verbose(`resolver: ${type}`);
  } catch (err) {
    throw new Error(t("messages:data.resolverFailed", { message: err.message }));
  }

  const docsFiles = getChapterFiles(docsDir, { type, configChapters: ctx.config?.chapters, projectRoot: root });

  // Determine relative path prefix for lang.links context
  const docsDirRel = path.relative(root, docsDir).replace(/\\/g, "/");

  const changedFiles = new Set();
  const plans = [];
  let totalReplaced = 0;
  let totalSkipped = 0;

  for (const file of docsFiles) {
    const filePath = path.join(docsDir, file);
    const originalBytes = fs.readFileSync(filePath);
    const original = originalBytes.toString("utf8");
    // Inject file path context for file-aware resolvers
    const fileRelPath = `${docsDirRel}/${file}`;
    const FILE_CONTEXT_RULES = {
      "lang.links":        (_labels) => [fileRelPath],
      "docs.langSwitcher": (labels) => [labels[0] || "relative", fileRelPath],
      "docs.nav":          (_labels) => [fileRelPath],
    };
    const wrappedResolveFn = (preset, source, method, a, labels, params) => {
      const rule = FILE_CONTEXT_RULES[`${source}.${method}`];
      if (rule) return resolveFn(preset, source, method, a, rule(labels), params);
      return resolveFn(preset, source, method, a, labels, params);
    };
    const result = processTemplate(original, analysis, file, wrappedResolveFn);

    totalReplaced += result.replaced;
    totalSkipped += result.skipped;

    if (result.replaced > 0) {
      changedFiles.add(file);
      const linesBefore = original.split("\n").length;
      const linesAfter = result.text.split("\n").length;

      if (ctx.dryRun || ctx.stdout) {
        console.log(`[data] ${file}: ${linesBefore} → ${linesAfter} lines (${linesAfter - linesBefore > 0 ? "+" : ""}${linesAfter - linesBefore})`);
      }

      if (!ctx.dryRun && !ctx.stdout) {
        plans.push(new DocumentUpdatePlan({
          filePath,
          originalBytes,
          proposedBytes: Buffer.from(result.text),
          validationResult: DocumentValidationResult.accepted(),
        }));
      } else {
        logger.verbose(`DRY-RUN: ${file} would be updated`);
      }
    }
  }

  if (!ctx.dryRun && !ctx.stdout) {
    ctx.aiSession?.assertActive();
    new DocumentUpdateTransaction(plans, { faultInjector: ctx.faultInjector }).commit();
    ctx.aiSession?.recordGeneratedFiles([...changedFiles].map((file) => path.join(docsDir, file)));
    for (const file of changedFiles) logger.verbose(`UPDATED: ${file}`);
  }

  const verb = ctx.dryRun ? "would update" : "updated";
  logger.log(t("messages:data.done", { count: changedFiles.size, verb, replaced: totalReplaced, skipped: totalSkipped }));
}

export default class DocsDataCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runData(ctx.docsCtx, ctx._rawArgs || []);
  }
}
