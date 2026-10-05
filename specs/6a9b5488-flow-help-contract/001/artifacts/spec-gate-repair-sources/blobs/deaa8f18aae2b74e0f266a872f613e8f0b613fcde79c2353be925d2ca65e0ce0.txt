/**
 * sennel/engine/template-merger.js
 *
 * テンプレート解決エンジン（ボトムアップ方式）。
 *
 * ディレクトリ階層を「最も具体的な層（project-local）→ 最も汎用的な層（base）」の
 * 順で探索し、各ファイルの正規パスと処理方法（そのまま使用 / 翻訳して使用）を決定する。
 *
 * {%block%} / {%/block%} / {%extends%} ディレクティブによるブロック単位マージにも対応。
 */

import fs from "fs";
import path from "path";
import { parseBlocks, BLOCK_START_RE, BLOCK_END_RE } from "./directive-parser.js";
import { resolveChainSafe, resolveMultiChains } from "../../lib/presets.js";
import { translateMarkdownWithBatches } from "./markdown-prompt-document.js";

const SPECIAL_FILES = new Set(["README.md", "flow-agent-instructions.md", "layout.md"]);

// ---------------------------------------------------------------------------
// レイヤー構築（ボトムアップ: 最も具体的な層から）
// ---------------------------------------------------------------------------

/**
 * preset 名と言語からテンプレートレイヤーを構築する。
 * 優先度の高い順（project-local → leaf → ... → base）で返す。
 *
 * @param {string} presetKey - preset 名（例: "cakephp2", "node-cli"）
 * @param {string} lang - ロケール（例: "ja"）
 * @param {string|null} [projectLocalDir] - プロジェクトローカルテンプレートディレクトリ
 * @param {string} [projectRoot] - プロジェクトルート（.sennel/presets/ 検索用）
 * @returns {string[]} レイヤーディレクトリ配列（優先度高い順）
 */
export function buildLayers(presetKey, lang, projectLocalDir, projectRoot) {
  const layers = [];

  // 1. project-local（最高優先）
  if (projectLocalDir && fs.existsSync(projectLocalDir)) {
    layers.push(projectLocalDir);
  }

  // 2. parent チェーンを leaf → root の順で追加（優先度高い順）
  const chain = resolveChainSafe(presetKey, projectRoot);

  // chain は root → leaf の順なので、逆順（leaf → root）で追加
  for (let i = chain.length - 1; i >= 0; i--) {
    const dir = path.join(chain[i].dir, "templates", lang);
    if (fs.existsSync(dir)) layers.push(dir);
  }

  return layers;
}

// ---------------------------------------------------------------------------
// 単一ファイル解決（ボトムアップ）
// ---------------------------------------------------------------------------

/**
 * 1つのファイルをボトムアップで解決する。
 * 優先度の高い層から順に探索し、@extends がなければそこで確定。
 * @extends がある場合は上位層の親を探し続ける。
 *
 * @param {string} fileName - テンプレートファイル名（例: "overview.md"）
 * @param {string[]} layers - レイヤーディレクトリ配列（優先度高い順）
 * @returns {{ path: string, content: string, extends: boolean }[]|null}
 *   ソース配列（優先度高い順）。削除マークなら null。ファイル未発見なら null。
 */
function resolveOneFile(fileName, layers) {
  const sources = [];

  for (const dir of layers) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf8");

    // 空ファイル → 削除マーク
    if (content.trim() === "") return null;

    const parsed = parseBlocks(content);
    sources.push({ path: filePath, content, extends: parsed.extends });

    // @extends: <name> → 別名ファイルを親として解決
    if (parsed.extends && parsed.extendsTarget) {
      const targetFileName = parsed.extendsTarget + ".md";
      const targetSources = resolveOneFile(targetFileName, layers);
      if (targetSources) {
        sources.push(...targetSources);
      }
      break;
    }

    // @extends なし → 親不要、ここで確定
    if (!parsed.extends) break;
  }

  return sources.length > 0 ? sources : null;
}

// ---------------------------------------------------------------------------
// ソースマージ
// ---------------------------------------------------------------------------

/**
 * 解決済みソース配列をマージする。
 * ソースは優先度高い順（project-local → base）で並んでいるため、
 * 逆順（base → project-local）で mergeTexts を適用する。
 *
 * additive フラグが true の場合、異なるチェーンからのソースを
 * ブロック加算（concatenate）でマージする。
 *
 * @param {{ path: string, content: string, extends: boolean }[]} sources
 * @param {boolean} [additive] - true の場合、加算マージを行う
 * @returns {string|null} マージ結果
 */
export function mergeResolved(sources, additive) {
  if (!sources || sources.length === 0) return null;
  if (sources.length === 1) return sources[0].content;

  if (additive) {
    return mergeSourcesAdditive(sources);
  }

  // base（末尾）から開始し、子を順に被せる
  let result = sources[sources.length - 1].content;
  for (let i = sources.length - 2; i >= 0; i--) {
    result = mergeTexts(result, sources[i].content);
  }
  return result;
}

/**
 * 加算マージ: 複数チェーンからのソースをブロック単位で結合する。
 * 同名ブロックは上書きではなく追記（concatenate）する。
 * @extends を持つソースは先にチェーン内マージし、その結果を加算する。
 */
function mergeSourcesAdditive(sources) {
  // @extends チェーンを先にグループ化してマージ
  const groups = [];
  let currentGroup = [];

  for (const src of sources) {
    currentGroup.push(src);
    if (!src.extends) {
      // チェーン内マージを実行
      if (currentGroup.length === 1) {
        groups.push(currentGroup[0].content);
      } else {
        let result = currentGroup[currentGroup.length - 1].content;
        for (let i = currentGroup.length - 2; i >= 0; i--) {
          result = mergeTexts(result, currentGroup[i].content);
        }
        groups.push(result);
      }
      currentGroup = [];
    }
  }
  // 残りの @extends グループ（ベースなし）があればそのまま追加
  for (const src of currentGroup) {
    groups.push(src.content);
  }

  if (groups.length === 1) return groups[0];

  // グループ間を加算マージ
  let result = groups[0];
  for (let i = 1; i < groups.length; i++) {
    result = addTexts(result, groups[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// テンプレート解決（メインエントリポイント）
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FileResolution
 * @property {string} fileName - テンプレートファイル名（例: "overview.md"）
 * @property {{ path: string, content: string, extends: boolean }[]} sources - ソース配列
 * @property {"use"|"translate"} action - 処理方法
 * @property {string} [from] - 翻訳元言語（action === "translate" の場合）
 * @property {string} [to] - 翻訳先言語（action === "translate" の場合）
 */

/**
 * 指定タイプ・言語の全テンプレートファイルを解決する。
 * 各ファイルについて正規パスと処理方法（use / translate）を決定する。
 *
 * 複数 type（配列）の場合、各チェーンのレイヤーを独立に構築し、
 * 同名ファイルは全チェーンのソースを加算マージする。
 *
 * @param {string|string[]} typePath - 型パス（例: "node-cli"）または配列（例: ["nextjs", "rest"]）
 * @param {string} lang - ターゲット言語
 * @param {Object} [opts]
 * @param {string|null} [opts.projectLocalDir] - プロジェクトローカルテンプレートディレクトリ
 * @param {string[]} [opts.fallbackLangs] - フォールバック言語リスト
 * @param {string[]} [opts.chaptersOrder] - preset.json の chapters 順序配列
 * @param {string} [opts.projectRoot] - プロジェクトルート（.sennel/presets/ 検索用）
 * @returns {FileResolution[]}
 */
export function resolveTemplates(typePath, lang, opts = {}) {
  const { projectLocalDir, fallbackLangs, chaptersOrder, projectRoot } = opts;

  const types = Array.isArray(typePath) ? typePath : [typePath];

  // 各チェーンの leaf key ごとにレイヤーセットを構築
  const chains = resolveMultiChains(types, projectRoot);
  const chainLayerSets = chains.map((chain) => {
    const leafKey = chain[chain.length - 1].key;
    return {
      leafKey,
      layers: buildLayers(leafKey, lang, projectLocalDir, projectRoot),
      fallbackSets: (fallbackLangs || [])
        .filter((l) => l !== lang)
        .map((fbLang) => ({
          lang: fbLang,
          layers: buildLayers(
            leafKey,
            fbLang,
            deriveFallbackProjectLocalDir(projectLocalDir, fbLang),
            projectRoot,
          ),
        })),
    };
  });

  // 全チェーンのレイヤーとフォールバックを統合（discoverFileNames 用）
  const allLayers = chainLayerSets.flatMap((s) => s.layers);
  const allFallbackSets = chainLayerSets.flatMap((s) => s.fallbackSets);

  // 解決対象ファイル名を収集
  const fileNames = discoverFileNames(allLayers, allFallbackSets, chaptersOrder);

  // 各ファイルを解決（複数チェーンからの加算マージ対応）
  const resolutions = [];
  for (const fileName of fileNames) {
    const resolution = resolveOneFileMultiChain(
      fileName,
      lang,
      chainLayerSets,
    );
    if (resolution) resolutions.push(resolution);
  }

  return resolutions;
}

/**
 * 1つのファイルを複数チェーンから解決し、加算マージする。
 * 同名ファイルが複数チェーンに存在する場合、各チェーンの解決結果のブロックを加算する。
 */
function resolveOneFileMultiChain(fileName, lang, chainLayerSets) {
  const resolved = [];

  for (const { layers, fallbackSets } of chainLayerSets) {
    const resolution = resolveOneFileWithFallback(fileName, lang, layers, fallbackSets);
    if (resolution) resolved.push(resolution);
  }

  if (resolved.length === 0) return null;
  if (resolved.length === 1) return resolved[0];

  // 複数チェーンで同名ファイルが見つかった → 加算マージ
  // 最初のチェーンの resolution をベースに、後続チェーンの新規ソースのみ追加
  const base = resolved[0];
  const originalCount = base.sources.length;
  const seenPaths = new Set(base.sources.map((s) => s.path));

  for (let i = 1; i < resolved.length; i++) {
    const additional = resolved[i];
    for (const src of additional.sources) {
      if (!seenPaths.has(src.path)) {
        seenPaths.add(src.path);
        base.sources.push(src);
      }
    }
    if (base.action === "translate" && additional.action === "use") {
      base.action = "use";
      delete base.from;
      delete base.to;
    }
  }
  // 異なるチェーン由来のソースが実際に追加された場合のみ additive
  base.additive = base.sources.length > originalCount;
  return base;
}

/**
 * 1つのファイルをターゲット言語 → フォールバック言語の順で解決する。
 */
function resolveOneFileWithFallback(fileName, lang, layers, fallbackSets) {
  // ターゲット言語で解決を試みる
  const sources = resolveOneFile(fileName, layers);
  if (sources) {
    return { fileName, sources, action: "use" };
  }

  // フォールバック言語で解決を試みる
  for (const fb of fallbackSets) {
    const fbSources = resolveOneFile(fileName, fb.layers);
    if (fbSources) {
      return {
        fileName,
        sources: fbSources,
        action: "translate",
        from: fb.lang,
        to: lang,
      };
    }
  }

  return null;
}

/**
 * フォールバック言語のプロジェクトローカルディレクトリを導出する。
 */
function deriveFallbackProjectLocalDir(projectLocalDir, fbLang) {
  if (!projectLocalDir) return null;
  return projectLocalDir.replace(/\/[^/]+\/docs\/?$/, `/${fbLang}/docs`);
}

/**
 * 解決対象のファイル名一覧を収集する。
 * chaptersOrder がある場合はそれに従い、なければ全レイヤーをスキャンする。
 */
function discoverFileNames(layers, fallbackSets, chaptersOrder) {
  if (chaptersOrder && chaptersOrder.length > 0) {
    return [...chaptersOrder, "README.md"];
  }

  // 全レイヤーをスキャンして .md ファイルを収集
  const allFiles = new Set();
  const allLayers = [...layers];
  for (const fb of fallbackSets) {
    allLayers.push(...fb.layers);
  }

  for (const dir of allLayers) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !SPECIAL_FILES.has(f));
    for (const f of files) allFiles.add(f);
  }

  const sorted = [...allFiles].sort();
  // README.md は常に末尾に追加
  sorted.push("README.md");
  return sorted;
}

// ---------------------------------------------------------------------------
// 章順序解決
// ---------------------------------------------------------------------------

/**
 * preset 名（または配列）から章の順序を解決する。
 * configChapters が指定されている場合はそれを最優先（プリセットを完全上書き）。
 * 複数 preset の場合、各チェーンの章を順に union マージする。
 *
 * @param {string|string[]} presetKeys - preset 名または配列
 * @param {string[]} [configChapters] - config.json の chapters 配列（最優先）
 * @param {string} [projectRoot] - プロジェクトルート（.sennel/presets/ 検索用）
 * @returns {string[]} 章ファイル名の順序配列
 */
export function resolveChaptersOrder(presetKeys, configChapters, projectRoot) {
  // config.json の chapters が定義されていればプリセットを完全上書き
  if (configChapters?.length) {
    // Support both old string[] and new object[] formats
    // Filter out chapters with exclude: true
    return configChapters
      .filter((c) => typeof c === "string" || !c.exclude)
      .map((c) => typeof c === "string" ? c : c.chapter);
  }

  const keys = Array.isArray(presetKeys) ? presetKeys : [presetKeys];

  const seen = new Set();
  const result = [];

  for (const key of keys) {
    const chain = resolveChainSafe(key, projectRoot);

    // chain 内で最も具体的な（leaf 側の）chapters を使用する。
    // 子が chapters を定義していれば親の chapters は含めない（上書き）。
    let chainChapters = [];
    for (const preset of chain) {
      if (preset.chapters?.length) chainChapters = preset.chapters;
    }

    // 全体結果に union マージ（重複除去）
    // Support both old string[] and new object[] formats
    for (const ch of chainChapters) {
      const name = typeof ch === "string" ? ch : ch.chapter;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// テンプレート翻訳ユーティリティ
// ---------------------------------------------------------------------------

/**
 * テンプレートを翻訳する。ディレクティブは保持し、Markdown のテキスト部分のみ翻訳する。
 *
 * @param {string} content - テンプレート内容
 * @param {string} fromLang - 元言語
 * @param {string} toLang - ターゲット言語
 * @param {Object} agent - AI エージェント設定
 * @param {string} [root] - プロジェクトルート
 * @returns {string}
 */
export async function translateTemplate(content, fromLang, toLang, agent, root, { maxCharacters } = {}) {
  return translateMarkdownWithBatches({
    content,
    documentId: `template:${fromLang}:${toLang}:${root || "project"}`,
    fromLang,
    toLang,
    agent,
    commandId: "docs.init",
    template: true,
    maxCharacters,
  });
}

// ---------------------------------------------------------------------------
// ブロックマージ（内部）
// ---------------------------------------------------------------------------

/**
 * 加算マージ: 2つのテンプレートのブロックを結合する。
 * 同名ブロックは上書きではなく追記（concatenate）する。
 * ブロックを持たないテンプレート同士は単純に結合する。
 *
 * @param {string} baseText - ベーステンプレート
 * @param {string} addText - 追加テンプレート
 * @returns {string} 加算マージ結果
 */
function addTexts(baseText, addText) {
  const base = parseBlocks(baseText);
  const add = parseBlocks(addText);

  // どちらもブロックを持たない → 単純結合
  if (base.blocks.size === 0 && add.blocks.size === 0) {
    return baseText + "\n\n" + addText;
  }

  const resultLines = [];

  // preamble: base を使用
  resultLines.push(...base.preamble);

  // base のブロックを走査し、add の同名ブロックがあれば追記
  for (const [name, baseBlock] of base.blocks) {
    const addBlock = add.blocks.get(name);

    resultLines.push(`<!-- {%block "${name}"%} -->`);
    resultLines.push(...baseBlock.content);

    if (addBlock) {
      resultLines.push("");
      resultLines.push(...addBlock.content);
    }

    resultLines.push("<!-- {%/block%} -->");
  }

  // add にのみ存在するブロック
  for (const [name, addBlock] of add.blocks) {
    if (!base.blocks.has(name)) {
      resultLines.push(`<!-- {%block "${name}"%} -->`);
      resultLines.push(...addBlock.content);
      resultLines.push("<!-- {%/block%} -->");
    }
  }

  // add の preamble（ブロック外コンテンツ）のうち、タイトル以外を追加
  if (add.preamble.length > 0 && add.blocks.size === 0) {
    resultLines.push("");
    resultLines.push(...add.preamble);
  }

  // postamble: base を使用
  resultLines.push(...base.postamble);

  return resultLines.join("\n");
}

/**
 * 親テンプレートと子テンプレートをブロック単位でマージする。
 *
 * @param {string} parentText - 親テンプレートの全文
 * @param {string} childText - 子テンプレートの全文
 * @returns {string} マージ結果
 */
function mergeTexts(parentText, childText) {
  const parent = parseBlocks(parentText);
  const child = parseBlocks(childText);

  // 子が @extends を持たない → 完全置換
  if (!child.extends) {
    return childText;
  }

  // マージされたブロック Map を構築（親ベース + 子でオーバーライド）
  const merged = new Map();
  for (const [name, parentBlock] of parent.blocks) {
    merged.set(name, child.blocks.get(name) || parentBlock);
  }
  for (const [name, childBlock] of child.blocks) {
    if (!parent.blocks.has(name)) {
      merged.set(name, childBlock);
    }
  }

  // 子が @extends を持つ → ブロック単位で親をマージ
  const resultLines = [];

  // preamble: 親を使用（子のpreambleは @extends 行のみのことが多い）
  resultLines.push(...parent.preamble);

  // ネストブロック名を収集（他ブロックの content 内に出現するブロック）
  // これらは expandBlockContent で展開されるため、個別出力をスキップする
  const nestedInMerged = collectNestedBlockNames(merged);

  // ブロック: 親のブロック順に走査し、子のオーバーライドを適用
  // ネストブロックは親ブロック展開時に expandBlockContent で出力済みなのでスキップ
  for (const [name] of parent.blocks) {
    if (nestedInMerged.has(name)) continue;
    resultLines.push(`<!-- {%block "${name}"%} -->`);
    expandBlockContent(merged.get(name).content, merged, resultLines);
    resultLines.push("<!-- {%/block%} -->");
  }

  // 子にのみ存在するブロック（親にないもの）を追加
  // ネストブロックは既に展開済みなのでスキップ
  for (const [name] of child.blocks) {
    if (!parent.blocks.has(name) && !nestedInMerged.has(name)) {
      resultLines.push(`<!-- {%block "${name}"%} -->`);
      expandBlockContent(merged.get(name).content, merged, resultLines);
      resultLines.push("<!-- {%/block%} -->");
    }
  }

  // postamble: 親を使用
  resultLines.push(...parent.postamble);

  return resultLines.join("\n");
}

/**
 * マージ済みブロック群の content 内に出現するネストブロック名を再帰的に収集する。
 * これらは expandBlockContent で既に展開されるため、第2ループでの重複追加を防ぐ。
 */
function collectNestedBlockNames(blocks) {
  const nested = new Set();
  for (const [, block] of blocks) {
    for (const line of block.content) {
      const m = line.trim().match(BLOCK_START_RE);
      if (m) nested.add(m[1]);
    }
  }
  return nested;
}

/**
 * ブロック content 内のネストされたブロックプレースホルダーを展開する。
 * content 配列には `<!-- @block: name -->` / `<!-- {%/block%} -->` が
 * プレースホルダーとして含まれる。これらを merged Map の内容で置換する。
 */
function expandBlockContent(contentLines, merged, resultLines) {
  for (const line of contentLines) {
    const trimmed = line.trim();
    const blockStart = trimmed.match(BLOCK_START_RE);
    if (blockStart) {
      const innerName = blockStart[1];
      const innerBlock = merged.get(innerName);
      resultLines.push(line);
      if (innerBlock) {
        expandBlockContent(innerBlock.content, merged, resultLines);
      }
      continue;
    }
    if (BLOCK_END_RE.test(trimmed)) {
      resultLines.push(line);
      continue;
    }
    resultLines.push(line);
  }
}
