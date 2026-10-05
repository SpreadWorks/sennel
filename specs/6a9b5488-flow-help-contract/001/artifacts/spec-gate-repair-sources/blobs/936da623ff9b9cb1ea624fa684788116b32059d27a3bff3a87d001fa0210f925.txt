/**
 * sennel/docs/lib/command-context.js
 *
 * docs コマンドから共通利用される analysis / chapters / text ヘルパー群。
 * CLI コンテキスト解決は src/docs/lib/docs-context.js の resolveDocsContext() を参照。
 */

import fs from "fs";
import path from "path";
import { managedOutputDir } from "../../lib/config.js";
import { resolveChaptersOrder } from "./template-merger.js";

/**
 * .sennel/output/ 配下の JSON ファイルを読み込む。
 *
 * @param {string} root - プロジェクトルート
 * @param {string} fileName - ファイル名（例: "analysis.json"）
 * @returns {Object|null} パース結果、見つからなければ null
 */
function loadOutputJson(root, fileName) {
  const filePath = path.join(managedOutputDir(root), fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * analysis.json を読み込む。
 *
 * @param {string} root - プロジェクトルート
 * @returns {Object|null} 解析データ、見つからなければ null
 */
export function loadAnalysisData(root) {
  return loadOutputJson(root, "analysis.json");
}

/**
 * analysis.json を読み込む。loadAnalysisData のエイリアス。
 *
 * @param {string} root - プロジェクトルート
 * @returns {Object|null}
 */
export function loadFullAnalysis(root) {
  return loadOutputJson(root, "analysis.json");
}

/**
 * docs ディレクトリから章ファイル一覧を取得する。
 * config.chapters > preset の chapters 順で返す。
 * フォールバック: *.md をアルファベット順（README.md, flow-agent-instructions.md, layout.md 除外）。
 *
 * @param {string} docsDir - docs ディレクトリの絶対パス
 * @param {Object} [options]
 * @param {string} [options.type] - プロジェクトタイプ（例: "cli/node-cli"）
 * @param {string[]} [options.configChapters] - config.json の chapters 配列（最優先）
 * @param {string} [options.projectRoot] - プロジェクトルート（.sennel/presets/ 検索用）
 * @returns {string[]} ファイル名の配列（順序付き）
 */
export function getChapterFiles(docsDir, options) {
  if (!fs.existsSync(docsDir)) return [];

  const type = options?.type;
  const configChapters = options?.configChapters;
  const projectRoot = options?.projectRoot;
  const EXCLUDE = new Set(["README.md", "flow-agent-instructions.md", "layout.md"]);

  if (type || configChapters?.length) {
    const chapters = resolveChaptersOrder(type || "base", configChapters, projectRoot);
    if (chapters.length > 0) {
      const existing = chapters.filter((f) => fs.existsSync(path.join(docsDir, f)));
      if (existing.length > 0) return existing;
    }
  }

  // Fallback: all *.md files alphabetically.
  return fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith(".md") && !EXCLUDE.has(f))
    .sort();
}

/**
 * ファイルを読み込む。存在しなければ空文字列を返す。
 *
 * @param {string} p - ファイルパス
 * @returns {string}
 */
export function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/**
 * AI レスポンスから先頭のプリアンブル（前置き）を除去する。
 * 最初の # 見出し行をコンテンツ開始位置とする。
 *
 * @param {string} text - AI レスポンステキスト
 * @param {number} [maxScanLines=10] - スキャンする最大行数
 * @returns {string}
 */
export function stripResponsePreamble(text, maxScanLines = 10) {
  const lines = text.split("\n");
  let startIdx = 0;
  for (let i = 0; i < Math.min(maxScanLines, lines.length); i++) {
    if (lines[i].startsWith("#")) { startIdx = i; break; }
  }
  return lines.slice(startIdx).join("\n").trimEnd() + "\n";
}
