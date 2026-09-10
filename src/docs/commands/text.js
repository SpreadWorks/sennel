#!/usr/bin/env node
/**
 * sennel/engine/tfill.js
 *
 * {{text}} ディレクティブ専用プロセッサ。
 * テンプレート内の {{text}} を LLM エージェント（claude / codex）で解決し、
 * ディレクティブ直後に説明文を挿入する。
 *
 * Usage:
 *   node sennel/engine/tfill.js --agent claude [--dry-run] [--timeout 60000] [--id <id>]
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseDirectives, TEXT_OPEN_RE } from "../lib/directive-parser.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { container } from "../../lib/container.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import {
  getEnrichedContext,
  buildTextSystemPrompt,
} from "../lib/text-prompts.js";
import { parseArgs } from "../../lib/cli.js";
import { resolveConcurrency, DEFAULT_CONCURRENCY } from "../../lib/config.js";
import { resolvePromptCharacterLimit } from "../../lib/config.js";
import { Command } from "../../lib/command.js";
import { createLogger } from "../../lib/progress.js";
import { translate } from "../../lib/i18n.js";
import { getChapterFiles, loadFullAnalysis } from "../lib/command-context.js";
import { iterateAnalysisCategories } from "../lib/analysis-entry.js";
import { repairJson } from "../../lib/json-parse.js";
import { EXIT_ERROR } from "../../lib/constants.js";
import {
  DocumentUpdatePlan,
  DocumentUpdateTransaction,
  DocumentValidationResult,
} from "../lib/document-update-plan.js";
import { generateDocumentationDirectives } from "../lib/documentation-text-batching.js";

const logger = createLogger("text");


/**
 * i18n の messages:text.preamblePatterns を RegExp 配列に変換する。
 */
function loadPreamblePatterns() {
  const t = translate();
  const entries = t.raw("messages:text.preamblePatterns");
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries.map((e) => new RegExp(e.pattern, e.flags || ""));
}

const ENDTEXT_LINE_RE = /^<!--\s*\{\{\/text\}\}\s*-->$/;

/**
 * Minimum line count in original to trigger shrinkage check.
 * Very short files (< 20 lines) are exempt from shrinkage validation.
 */
const SHRINKAGE_MIN_LINES = 20;

/**
 * If the result has fewer than this ratio of the original lines, reject it.
 * e.g. 0.5 = reject if result is less than 50% of original.
 */
const SHRINKAGE_THRESHOLD = 0.5;

/**
 * バッチ結果の品質を検証する。
 * 行数の大幅縮小や filled 率の低さを検出してリジェクトする。
 *
 * @param {string} original - 元のファイル内容
 * @param {{ text: string, filled: number, skipped: number }} result - バッチ処理結果
 * @param {number} totalDirectives - ファイル内の {{text}} ディレクティブ総数
 * @param {string} fileName - ファイル名（ログ用）
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateBatchResult(original, result, totalDirectives, fileName) {
  const origLines = original.split("\n").length;
  const newLines = result.text.split("\n").length;

  // 縮小検出: 元ファイルが十分長く、結果がしきい値以下に縮小した場合
  if (origLines >= SHRINKAGE_MIN_LINES && newLines < origLines * SHRINKAGE_THRESHOLD) {
    return {
      ok: false,
      reason: `content shrinkage detected: ${origLines} → ${newLines} lines (${Math.round(newLines / origLines * 100)}%). Original preserved.`,
    };
  }

  // filled 率: 複数ディレクティブがあるのに全く埋まらなかった場合
  if (totalDirectives > 0 && result.filled === 0) {
    return {
      ok: false,
      reason: `0/${totalDirectives} directives filled. No file update was published.`,
    };
  }

  // filled 率: 半数以上が埋まらなかった場合は警告（ただし書き込みは許可）
  if (totalDirectives > 1 && result.filled < totalDirectives * SHRINKAGE_THRESHOLD) {
    logger.log(`WARN ${fileName}: only ${result.filled}/${totalDirectives} directives filled.`);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// バッチモード：ファイル単位で全ディレクティブをbounded map/reduceで処理
// ---------------------------------------------------------------------------

/**
 * テンプレートファイルの {{text}} ディレクティブ後にある既存生成コンテンツを
 * 除去してクリーンなテンプレート状態に戻す。
 * processTemplate の endLine 計算と同じ境界ロジックを使用する。
 */
function stripFillContent(text, directiveId) {
  const lines = text.split("\n");
  const selectedLines = directiveId === undefined
    ? null
    : new Set(parseDirectives(text)
      .filter((directive) => directive.type === "text" && directive.params?.id === directiveId)
      .map((directive) => directive.line));
  const result = [];
  let i = 0;
  while (i < lines.length) {
    result.push(lines[i]);
    if (TEXT_OPEN_RE.test(lines[i].trim()) && (selectedLines === null || selectedLines.has(i))) {
      i++;
      // {{/text}} 終了タグまでスキップ
      while (i < lines.length && !ENDTEXT_LINE_RE.test(lines[i].trim())) {
        i++;
      }
      // 終了タグ自体は結果に含める
      if (i < lines.length) {
        result.push(lines[i]);
        i++;
      }
    } else {
      i++;
    }
  }
  return result.join("\n");
}

/**
 * バッチ結果のファイルで埋められたディレクティブ数をカウントする。
 * ディレクティブ行の次の非空行が ## / <!-- @ でなければ filled と判定する。
 */
function countFilledInBatch(fileText) {
  const lines = fileText.split("\n");
  let filled = 0;
  for (let i = 0; i < lines.length; i++) {
    if (TEXT_OPEN_RE.test(lines[i].trim())) {
      // 開始タグと終了タグの間に非空行があれば filled
      let hasContent = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (ENDTEXT_LINE_RE.test(lines[j].trim())) break;
        if (lines[j].trim() !== "") { hasContent = true; break; }
      }
      if (hasContent) filled++;
    }
  }
  return filled;
}

/**
 * JSON レスポンスをパースする。コードフェンスがあれば除去する。
 *
 * @param {string} response - AI のレスポンス
 * @returns {Object|null} パース結果、失敗時は null
 */
function parseBatchJsonResponse(response) {
  try {
    return JSON.parse(repairJson(response));
  } catch (_) {
    return null;
  }
}

function directiveBatchId(directive, index) {
  return directive.params?.id || `d${index}`;
}

function resolveBatchContextOptions(srcRoot, retryCount) {
  if (retryCount === undefined && typeof srcRoot === "number") {
    return { srcRoot: undefined, retryCount: srcRoot };
  }
  return { srcRoot, retryCount };
}

/**
 * JSON レスポンスを元のファイルのディレクティブ位置に挿入する。
 *
 * @param {string} text - 元のファイル内容（stripFillContent 済み）
 * @param {{ type: string, line: number, endLine: number, params?: Object, prompt: string }[]} textFills - ディレクティブ一覧
 * @param {Object} jsonData - パース済み JSON（id → テキスト）
 * @returns {{ text: string, filled: number, skipped: number }}
 */
function applyBatchJsonToFile(text, textFills, jsonData) {
  const lines = text.split("\n");
  let filled = 0;
  let skipped = 0;

  // 逆順で挿入（行番号のずれを防ぐ）
  for (let i = textFills.length - 1; i >= 0; i--) {
    const d = textFills[i];
    const id = directiveBatchId(d, i);
    let generated = jsonData[id];

    if (!generated) {
      skipped++;
      continue;
    }

    const endLine = d.endLine;
    if (endLine < 0) {
      skipped++;
      continue;
    }

    if (d.params?.maxLines) generated = generated.split("\n").slice(0, d.params.maxLines).join("\n");
    if (d.params?.maxChars) generated = generated.slice(0, d.params.maxChars);
    const content = [d.params?.header, generated, d.params?.footer].filter(Boolean).join("\n");
    const endTag = lines[endLine];
    const newLines = [d.raw, "\n" + content, endTag];
    lines.splice(d.line, endLine - d.line + 1, ...newLines);
    filled++;
  }

  let result = lines.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return { text: result, filled, skipped };
}

/**
 * ファイル内のすべての {{text}} ディレクティブをbounded LLM batchesで処理する。
 * AI には JSON 形式でディレクティブごとのテキストを返させ、
 * コード側で元ファイルの該当位置に挿入する。
 *
 * @returns {{ text: string, filled: number, skipped: number }}
 */
async function processTemplateFileBatch(text, analysis, fileName, agent, dryRun, _preamblePatterns, systemPrompt, _filterId, concurrency, lang, srcRoot, retryCount, promptCharacterLimit) {
  const batchOptions = resolveBatchContextOptions(srcRoot, retryCount);
  // cleanText を先に計算してから parseDirectives を呼ぶ。
  // stripFillContent は既存コンテンツを除去するため行数が変わる。
  // parseDirectives の行番号は applyBatchJsonToFile に渡す text と一致させる必要がある。
  const cleanText = stripFillContent(text, _filterId);
  const directives = parseDirectives(cleanText);
  let textFills = directives.filter((d) => d.type === "text");
  if (_filterId) textFills = textFills.filter((directive) => directive.params?.id === _filterId);

  if (textFills.length === 0) return { text, filled: 0, skipped: 0 };

  // Determine the deepest mode across all directives in this file
  const hasDeep = textFills.some((d) => d.params?.mode === "deep");
  const batchMode = hasDeep ? "deep" : "light";
  const enriched = getEnrichedContext(analysis, fileName, batchMode, batchOptions.srcRoot);
  // The complete analysis is canonical source evidence. Directive-category
  // projections can legitimately be empty (for example, project structure),
  // so using one here would make a bounded batch complete but ungrounded.
  const contextData = analysis;

  if (dryRun) {
    console.log(`[text] DRY-RUN batch ${fileName}: ${textFills.length} directive(s)`);
    return { text, filled: 0, skipped: textFills.length };
  }

  logger.verbose(`Batch ${fileName}: ${textFills.length} directive(s)`);
  const jsonData = await generateDocumentationDirectives({
    cleanText,
    enrichedContext: enriched,
    analysisContext: contextData,
    textFills,
    fileName,
    systemPrompt,
    lang,
    agent,
    executionWorkDir: batchOptions.srcRoot,
    retryCount: batchOptions.retryCount || 0,
    maxCharacters: promptCharacterLimit,
    concurrency: concurrency || DEFAULT_CONCURRENCY,
  });

  const applied = applyBatchJsonToFile(cleanText, textFills, jsonData);
  logger.verbose(`Batch DONE ${fileName}: ${applied.filled}/${textFills.length} filled`);

  return applied;
}

// ---------------------------------------------------------------------------
// テンプレート処理
// ---------------------------------------------------------------------------

/**
 * 1 ファイルの {{text}} ディレクティブをすべて処理する。
 *
 * @param {string} text        - テンプレート全文
 * @param {Object} analysis    - analysis.json
 * @param {string} fileName    - ファイル名
 * @param {Object} agent       - Agent service
 * @param {boolean} dryRun     - dry-run モード
 * @returns {{ text: string, filled: number, skipped: number }}
 */
async function processTemplate(text, analysis, fileName, agent, dryRun, preamblePatterns, systemPrompt, filterId, concurrency, lang, srcRoot, retryCount, promptCharacterLimit) {
  return processTemplateFileBatch(
    text, analysis, fileName, agent, dryRun, preamblePatterns, systemPrompt,
    filterId, concurrency, lang, srcRoot, retryCount, promptCharacterLimit,
  );
}

// ---------------------------------------------------------------------------
// textFillFromAnalysis (エクスポート用: forge.js などから呼び出し可能)
// ---------------------------------------------------------------------------
/**
 * ファイル内の全 {{text}} ディレクティブが埋まっているかチェックする。
 * 1 つでも空のディレクティブがあれば false を返す。
 *
 * @param {string} text - ファイル内容
 * @returns {boolean} 全ディレクティブが埋まっている場合 true
 */
function allTextDirectivesFilled(text) {
  const directives = parseDirectives(text);
  const textFills = directives.filter((d) => d.type === "text");
  if (textFills.length === 0) return true;

  const lines = text.split("\n");
  for (const d of textFills) {
    if (d.endLine < 0) return false;
    let hasContent = false;
    for (let j = d.line + 1; j < d.endLine; j++) {
      if (lines[j].trim() !== "") { hasContent = true; break; }
    }
    if (!hasContent) return false;
  }
  return true;
}

/**
 * @param {string} root       - リポジトリルート
 * @param {Object} analysis   - analysis.json データ
 * @param {string} commandId  - コマンドID (docs.text)
 * @param {string} [srcRoot]  - ソースルート
 * @param {Object} [opts]     - オプション
 * @param {string[]} [opts.files] - 処理対象ファイル名の配列。指定時はそのファイルのみ処理する
 * @returns {{ filled: number, skipped: number, files: string[] }}
 */
export async function textFillFromAnalysis(root, analysis, commandId, srcRoot, opts) {
  if (!analysis) return { filled: 0, skipped: 0, files: [] };

  const cfg = container.get("config");
  const agent = container.get("agent");
  if (!agent.resolve(commandId || "docs.text")) {
    throw new Error("No agent configured. Set 'agent.default' in config.json or run 'sennel setup'.");
  }
  const preamblePatterns = loadPreamblePatterns();
  const documentStyle = cfg?.docs?.style;
  const lang = cfg?.docs?.defaultLanguage;
  const systemPrompt = buildTextSystemPrompt(documentStyle, lang);
  const type = cfg?.type || undefined;
  const concurrency = resolveConcurrency(cfg);
  const promptCharacterLimit = resolvePromptCharacterLimit(cfg);
  const docsDir = path.join(root, "docs");
  const resolvedSrcRoot = srcRoot || root;

  const targetFiles = opts?.files || getChapterFiles(docsDir, { type, configChapters: cfg?.chapters, projectRoot: root });

  const changedFiles = [];
  const plans = [];
  let totalFilled = 0;
  let totalSkipped = 0;

  // Batch mode: file-level parallelism; each file owns a bounded prompt plan.
  const fileResults = await mapWithConcurrency(targetFiles, concurrency, async (file) => {
    const filePath = path.join(docsDir, file);
    const originalBytes = fs.readFileSync(filePath);
    const original = originalBytes.toString("utf8");
    const retryCount = Number(cfg?.agent?.retryCount) || 0;
    const result = await processTemplateFileBatch(original, analysis, file, agent, false, preamblePatterns, systemPrompt, undefined, concurrency, lang, resolvedSrcRoot, retryCount, promptCharacterLimit);
    return { file, filePath, originalBytes, original, result };
  });
  fileResults.throwIfErrors();

  for (let i = 0; i < fileResults.length; i++) {
    const entry = fileResults[i];
    const { file, filePath, originalBytes, original, result } = entry.value;
    if (!result) continue;

    const totalDirectives = parseDirectives(original).filter((d) => d.type === "text").length;
    const validation = validateBatchResult(original, result, totalDirectives, file);
    const validationResult = validation.ok
      ? DocumentValidationResult.accepted()
      : DocumentValidationResult.rejected(validation.reason);
    plans.push(new DocumentUpdatePlan({
      filePath,
      originalBytes,
      proposedBytes: Buffer.from(result.text),
      validationResult,
    }));

    totalFilled += result.filled;
    totalSkipped += result.skipped;

    if (result.filled > 0) {
      changedFiles.push(file);
    }
  }

  new DocumentUpdateTransaction(plans, { faultInjector: opts?.faultInjector }).commit();

  return { filled: totalFilled, skipped: totalSkipped, files: changedFiles, errors: [] };
}

// ---------------------------------------------------------------------------
// Diff-based chapter detection
// ---------------------------------------------------------------------------

/**
 * Compare each entry's stored hash against the current source file's hash.
 * Returns a Set of chapter names that need regeneration, or null if
 * diff detection is not possible (e.g., no enriched entries with chapter field).
 */
function detectChangedChapters(analysis, srcRoot) {
  const chapters = new Set();
  let hasChapterField = false;

  for (const [, catData] of iterateAnalysisCategories(analysis)) {
    for (const entry of catData.entries) {
      if (!entry.chapter) continue;
      hasChapterField = true;

      if (!entry.file || !entry.hash) {
        chapters.add(entry.chapter);
        continue;
      }

      const absPath = path.join(srcRoot, entry.file);
      if (!fs.existsSync(absPath)) {
        chapters.add(entry.chapter);
        continue;
      }

      const currentHash = crypto.createHash("md5")
        .update(fs.readFileSync(absPath, "utf8"))
        .digest("hex");
      if (entry.hash !== currentHash) {
        chapters.add(entry.chapter);
      }
    }
  }

  return hasChapterField ? chapters : null;
}

// ---------------------------------------------------------------------------
// CLI メイン
// ---------------------------------------------------------------------------
async function runText(ctx, rawArgs) {
  // CLI モード
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--dry-run", "--per-directive", "--force"],
      options: ["--id", "--lang", "--docs-dir", "--files"],
      defaults: { dryRun: false, perDirective: false, force: false, id: "", lang: "", docsDir: "", files: "" },
    });
    if (cli.help) {
      const t = translate();
      const h = t.raw("ui:help.cmdHelp.text");
      const o = h.options;
      console.log([
        h.usage, "", "Options:",
        `  ${o.id}`, `  ${o.dryRun}`, `  ${o.perDirective}`,
        `  ${o.help}`,
      ].join("\n"));
      return;
    }

    ctx = resolveDocsContext(container, cli, { commandId: "docs.text" });
    ctx.dryRun = cli.dryRun;
    ctx.perDirective = cli.perDirective;
    ctx.force = cli.force;
    ctx.id = cli.id;
    if (cli.files) ctx.files = cli.files.split(",").map((f) => f.trim()).filter(Boolean);
  }

  const { root, srcRoot, config: cfg, docsDir } = ctx;

  const analysis = loadFullAnalysis(root) || {};
  if (Object.keys(analysis).length === 0) {
    logger.log("WARN: analysis.json not found. Proceeding with empty analysis context.");
  }
  const agent = ctx.agent || container.get("agent");
  if (!agent.resolve(ctx.commandId || "docs.text")) {
    throw new Error("No agent configured. Set 'agent.default' in config.json or run 'sennel setup'.");
  }

  const preamblePatterns = loadPreamblePatterns();
  const documentStyle = cfg.docs?.style;
  const lang = ctx.outputLang;
  const systemPrompt = buildTextSystemPrompt(documentStyle, lang);
  const concurrency = resolveConcurrency(cfg);
  const promptCharacterLimit = resolvePromptCharacterLimit(cfg);

  // File selection: use ctx.files if provided, otherwise get all chapter files and strip
  let targetFiles;
  if (ctx.files) {
    targetFiles = ctx.files;
  } else {
    targetFiles = getChapterFiles(docsDir, { type: ctx.type, configChapters: cfg.chapters, projectRoot: root });

    // Diff-based chapter filtering: skip chapters whose entries are unchanged
    if (!ctx.force) {
      const changedChapters = detectChangedChapters(analysis, srcRoot);
      if (changedChapters) {
        if (changedChapters.size === 0) {
          // No source changes, but check for unfilled text directives
          const unfilledFiles = targetFiles.filter((f) => {
            const content = fs.readFileSync(path.join(docsDir, f), "utf8");
            return !allTextDirectivesFilled(content);
          });
          if (unfilledFiles.length === 0) {
            logger.log("No source changes detected. Use --force to regenerate all chapters.");
            return { errors: [] };
          }
          targetFiles = unfilledFiles;
          logger.log(`No source changes, but ${unfilledFiles.length} file(s) have unfilled text directives.`);
        } else {
          const before = targetFiles.length;
          targetFiles = targetFiles.filter((f) => {
            const chapterName = f.replace(/\.md$/, "");
            return changedChapters.has(chapterName);
          });
          logger.log(`Diff: ${changedChapters.size} chapter(s) changed [${[...changedChapters].join(", ")}], processing ${targetFiles.length}/${before} file(s).`);
        }
      }
    }

  }

  let totalFilled = 0;
  let totalSkipped = 0;
  const changedFiles = new Set();

  // --id narrows the scoped batch plan to one directive.
  if (ctx.id) {
    ctx.perDirective = true;
    logger.verbose(`--id=${ctx.id}: per-directive mode forced.`);
  }

  const retryCount = Number(cfg?.agent?.retryCount) || 0;
  const processFn = processTemplateFileBatch;
  if (!ctx.perDirective) {
    logger.verbose(`Mode: bounded batch (${targetFiles.length} file(s), concurrency=${concurrency}).`);
  }

  // Prepare file entries (filter for --id before parallel dispatch)
  const fileEntries = [];
  for (const file of targetFiles) {
    const filePath = path.join(docsDir, file);
    const originalBytes = fs.readFileSync(filePath);
    const original = originalBytes.toString("utf8");

    if (ctx.id) {
      const directives = parseDirectives(original);
      const hasId = directives.some((d) => d.type === "text" && d.params?.id === ctx.id);
      if (!hasId) continue;
    }

    fileEntries.push({ file, filePath, originalBytes, original });
  }

  // File-level concurrency is independent from each file's bounded prompt plan.
  const fileConcurrency = concurrency;
  const plans = [];
  const fileResults = await mapWithConcurrency(fileEntries, fileConcurrency, async (entry) => {
    const { file, original } = entry;
    logger.verbose(`start: ${file}`);
    const result = await processFn(original, analysis, file, agent, ctx.dryRun, preamblePatterns, systemPrompt, ctx.id || undefined, concurrency, lang, srcRoot, retryCount, promptCharacterLimit);
    logger.verbose(`done: ${file}`);
    return { ...entry, result };
  });
  fileResults.throwIfErrors();

  // Apply results
  for (let i = 0; i < fileEntries.length; i++) {
    const resultEntry = fileResults[i];
    const { file, filePath, originalBytes, original, result } = resultEntry.value;
    if (!result) continue;

    // バッチモードの場合は結果を検証
    let validationResult = DocumentValidationResult.accepted();
    if (!ctx.perDirective && !ctx.dryRun) {
      const totalDirectives = parseDirectives(original).filter((d) => d.type === "text").length;
      const validation = validateBatchResult(original, result, totalDirectives, file);
      if (!validation.ok) {
        logger.log(`REJECTED ${file}: ${validation.reason}`);
        validationResult = DocumentValidationResult.rejected(validation.reason);
      }
    }

    totalFilled += result.filled;
    totalSkipped += result.skipped;

    if (!ctx.dryRun && (result.filled > 0 || !validationResult.ok)) {
      plans.push(new DocumentUpdatePlan({
        filePath,
        originalBytes,
        proposedBytes: Buffer.from(result.text),
        validationResult,
      }));
    }

    if (result.filled > 0) {
      changedFiles.add(file);
    }
  }

  if (!ctx.dryRun) {
    new DocumentUpdateTransaction(plans, { faultInjector: ctx.faultInjector }).commit();
    for (const file of changedFiles) logger.verbose(`UPDATED: ${file}`);
  }

  logger.log(`Done. ${changedFiles.size} file(s) updated. filled: ${totalFilled}, skipped: ${totalSkipped}.`);
  return { errors: [] };
}

export { stripFillContent, countFilledInBatch, processTemplateFileBatch, processTemplate, allTextDirectivesFilled, validateBatchResult, parseBatchJsonResponse, applyBatchJsonToFile, detectChangedChapters };

export default class DocsTextCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    const result = await runText(ctx.docsCtx, ctx._rawArgs || []);
    if (result?.errors?.length > 0) {
      const err = new Error(`${result.errors.length} file(s) failed: ${result.errors.join(", ")}`);
      err.exitCode = EXIT_ERROR;
      err.data = result;
      err.agentError = true;
      throw err;
    }
    return result;
  }
}
