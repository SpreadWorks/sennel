/**
 * src/docs/lib/chapter-resolver.js
 *
 * chapters のマージ、{{data}} カテゴリ抽出、カテゴリ→章マッピング構築。
 * enrich の静的 chapter 割り当てと text の getAnalysisContext で共通利用する。
 */

import fs from "fs";
import path from "path";
import { parseDirectives } from "./directive-parser.js";

// ---------------------------------------------------------------------------
// chapters merge (R1, R2)
// ---------------------------------------------------------------------------

/**
 * preset.json の chapters と config.json の chapters をマージする。
 *
 * - preset の配列順をベースとする
 * - config で exclude: true の章を除外する
 * - config の desc は preset の desc を上書きする
 * - config にあって preset にない章（exclude でないもの）を末尾に追加する
 *
 * @param {Array<{chapter: string, desc?: string}>} presetChapters
 * @param {Array<{chapter: string, desc?: string, exclude?: boolean}>} [configChapters]
 * @returns {Array<{chapter: string, desc?: string}>}
 */
export function mergeChapters(presetChapters, configChapters) {
  if (!configChapters?.length) return [...presetChapters];

  const configMap = new Map();
  for (const entry of configChapters) {
    configMap.set(entry.chapter, entry);
  }

  // Merge preset order with config overrides
  const result = [];
  const seen = new Set();

  for (const preset of presetChapters) {
    const override = configMap.get(preset.chapter);
    if (override?.exclude) continue;

    const merged = { chapter: preset.chapter };
    if (override?.desc != null) {
      merged.desc = override.desc;
    } else if (preset.desc != null) {
      merged.desc = preset.desc;
    }
    result.push(merged);
    seen.add(preset.chapter);
  }

  // Append config-only chapters at the end
  for (const entry of configChapters) {
    if (seen.has(entry.chapter)) continue;
    if (entry.exclude) continue;
    const added = { chapter: entry.chapter };
    if (entry.desc != null) added.desc = entry.desc;
    result.push(added);
  }

  return result;
}

// ---------------------------------------------------------------------------
// {{data}} category extraction (R5)
// ---------------------------------------------------------------------------

/**
 * テンプレートファイルの内容から {{data}} ディレクティブの参照カテゴリ（source 名）を抽出する。
 *
 * {{data("preset.SOURCE.method")}} の SOURCE 部分を Set で返す。
 *
 * @param {string} templateContent - テンプレートファイルの内容
 * @returns {Set<string>} カテゴリ名の Set
 */
export function extractDataCategories(templateContent) {
  const categories = new Set();
  const directives = parseDirectives(templateContent);

  for (const d of directives) {
    if (d.type !== "data") continue;
    // d.source is the middle part of "preset.source.method"
    if (d.source) categories.add(d.source);
  }

  return categories;
}

// ---------------------------------------------------------------------------
// category → chapter mapping (R4)
// ---------------------------------------------------------------------------

/**
 * 章ごとの {{data}} カテゴリ情報から、カテゴリ→章名のマッピングを構築する。
 *
 * 同じカテゴリが複数の章に出現する場合、最初の章が優先される。
 *
 * @param {Map<string, Set<string>>} chapterCategories - Map<chapterFileName, Set<categoryName>>
 * @returns {Map<string, string>} Map<categoryName, chapterNameWithoutMd>
 */
export function buildCategoryToChapterMap(chapterCategories) {
  const map = new Map();

  for (const [chapterFile, categories] of chapterCategories) {
    const chapterName = chapterFile.replace(/\.md$/, "");
    for (const cat of categories) {
      if (!map.has(cat)) {
        map.set(cat, chapterName);
      }
    }
  }

  return map;
}

/**
 * docs ディレクトリ内の全章テンプレートを読み、カテゴリ→章マッピングを構築する。
 *
 * @param {string} docsDir - docs/ ディレクトリのパス
 * @param {string[]} chapterFiles - 章ファイル名の配列
 * @returns {Map<string, string>} Map<categoryName, chapterNameWithoutMd>
 */
export function buildCategoryMapFromDocs(docsDir, chapterFiles) {
  const chapterCategories = new Map();

  for (const file of chapterFiles) {
    const filePath = path.join(docsDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const categories = extractDataCategories(content);
      chapterCategories.set(file, categories);
    } catch (_) {
      // File not found or unreadable — skip
      chapterCategories.set(file, new Set());
    }
  }

  return buildCategoryToChapterMap(chapterCategories);
}
