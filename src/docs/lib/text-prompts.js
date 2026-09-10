/**
 * src/docs/lib/text-prompts.js
 *
 * {{text}} ディレクティブ処理用のプロンプト構築ユーティリティ。
 * text.js から分離。
 */

import fs from "fs";
import path from "path";
import { createI18n } from "../../lib/i18n.js";
import { iterateAnalysisCategories } from "./analysis-entry.js";
import { minify } from "./minify.js";

/**
 * {{data}} カテゴリ名 → analysis.json の必要セクションへのマッピング。
 */
const CATEGORY_TO_SECTIONS = {
  controllers:             (a) => ({ controllers: a.controllers }),
  "controllers.deps":      (a) => ({ controllers: a.controllers }),
  "controllers.csv":       (a) => ({ controllers: a.controllers }),
  "controllers.actions":   (a) => ({ titlesGraphMapping: a.config?.titlesGraphMapping }),
  tables:                  (a) => ({ models: a.models }),
  "tables.fk":             (a) => ({ models: a.models }),
  "tables.sync":           (a) => ({ models: a.models }),
  "models.logic":          (a) => ({ logicClasses: a.config?.logicClasses }),
  "models.logic.methods":  (a) => ({ logicClasses: a.config?.logicClasses }),
  "models.relations":      (a) => ({ models: a.models }),
  "models.er":             (a) => ({ models: a.models }),
  commands:                (a) => ({ commands: a.commands }),
  "commands.deps":         (a) => ({ commands: a.commands }),
  "commands.flow":         (a) => ({ commandDetails: a.config?.commandDetails }),
  "config.stack":          ()  => ({}),
  "config.composer":       (a) => ({ composerDeps: a.package?.composerDeps }),
  "config.assets":         (a) => ({ assets: a.config?.assets }),
  "config.bootstrap":      (a) => ({ bootstrap: a.config?.bootstrap }),
  "config.db":             (a) => ({ bootstrap: a.config?.bootstrap }),
  "config.constants":      (a) => ({ constants: a.config?.constants }),
  "config.constants.select":(a) => ({ constants: a.config?.constants }),
  "config.auth":           (a) => ({ appController: a.config?.appController }),
  "config.acl":            (a) => ({ acl: a.config?.acl }),
  "views.helpers":         (a) => ({ helpers: a.views?.helpers }),
  "views.layouts":         (a) => ({ layouts: a.views?.layouts }),
  "views.elements":        (a) => ({ elements: a.views?.elements }),
  "views.components":      (a) => ({ permissionComponent: a.config?.permissionComponent }),
  libs:                    (a) => ({ libraries: a.libs?.libraries }),
  "libs.errors":           (a) => ({ libraries: a.libs?.libraries }),
  "libs.behaviors":        (a) => ({ behaviors: a.libs?.behaviors }),
  "libs.sql":              (a) => ({ sqlFiles: a.libs?.sqlFiles }),
  "libs.appmodel":         (a) => ({ appModel: a.config?.appModel }),
  email:                   (a) => ({ emailNotifications: a.email?.emailNotifications }),
  tests:                   (a) => ({ testStructure: a.tests?.testStructure }),
  docker:                  ()  => ({}),
};

/**
 * ファイル内の全ディレクティブから、{{text}} に必要なコンテキストデータを動的に収集する。
 */
export function getAnalysisContext(analysis, directives) {
  if (!analysis) return {};
  const data = {};

  if (analysis.controllers?.summary) data.controllersSummary = analysis.controllers.summary;
  if (analysis.models?.summary) data.modelsSummary = analysis.models.summary;
  if (analysis.commands?.summary) data.commandsSummary = analysis.commands.summary;
  if (analysis.routes?.summary) data.routesSummary = analysis.routes.summary;

  const dataFills = directives.filter((d) => d.type === "data");
  for (const d of dataFills) {
    const extractor = CATEGORY_TO_SECTIONS[d.category];
    if (extractor) {
      const section = extractor(analysis);
      for (const [key, value] of Object.entries(section)) {
        if (value != null && !(key in data)) {
          data[key] = value;
        }
      }
    }
  }

  return data;
}

/**
 * ファイル名から章名を抽出する。
 * "overview.md" → "overview"
 */
function chapterNameFromFile(fileName) {
  return fileName.replace(/\.md$/, "");
}

/**
 * enriched analysis から章に該当するエントリのコンテキストを構築する。
 *
 * @param {Object} analysis - analysis.json (enrichedAt あり)
 * @param {string} fileName - 章ファイル名 (e.g. "overview.md")
 * @param {string} mode - "light" or "deep"
 * @param {string} [srcRoot] - ソースルート（deep モード時に使用）
 * @returns {string|null} enriched コンテキスト文字列、なければ null
 */
export function getEnrichedContext(analysis, fileName, mode, srcRoot) {
  if (!analysis?.enrichedAt) return null;

  const chapterName = chapterNameFromFile(fileName);
  const entries = [];

  for (const [, data] of iterateAnalysisCategories(analysis)) {
    for (const item of data.entries) {
      if (item.chapter === chapterName && (item.summary || item.detail)) {
        entries.push(item);
      }
    }
  }

  if (entries.length === 0) return null;

  const parts = [];
  parts.push(`## Enriched Analysis (${entries.length} entries for chapter: ${chapterName})`);

  for (const entry of entries) {
    const name = entry.file || entry.name || entry.className || "unknown";
    parts.push(`\n### ${name}`);
    if (entry.role) parts.push(`Role: ${entry.role}`);
    if (entry.summary) parts.push(`Summary: ${entry.summary}`);
    if (entry.detail) parts.push(`Detail: ${entry.detail}`);

    if (mode === "deep" && srcRoot) {
      const filePath = entry.file || entry.name;
      if (filePath) {
        try {
          const absPath = path.resolve(srcRoot, filePath);
          let code = fs.readFileSync(absPath, "utf8");
          code = minify(code, filePath);
          parts.push("```");
          parts.push(code);
          parts.push("```");
        } catch (_) {
          // File not found, skip
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * documentStyle → プロンプトヘッダー行を生成する。
 */
function buildPromptHeader(documentStyle, lang) {
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const header = [];
  if (documentStyle) {
    const purposes = t.raw("text.purposes") || {};
    const tones = t.raw("text.tones") || {};
    const purposeLabel = purposes[documentStyle.purpose] || documentStyle.purpose;
    header.push(t("text.roleTemplate", { purpose: purposeLabel }));
    if (documentStyle.tone) {
      header.push(tones[documentStyle.tone] || documentStyle.tone);
    }
    if (documentStyle.customInstruction) {
      header.push("", documentStyle.customInstruction);
    }
  } else {
    header.push(t("text.defaultRole"));
  }
  return header;
}

/**
 * ディレクティブの params から出力ルール文字列を生成する。
 */
export function formatLimitRule(params) {
  const parts = [];
  if (params?.maxLines) {
    parts.push(`max ${params.maxLines} lines`);
  }
  if (params?.maxChars) {
    parts.push(`max ${params.maxChars} chars`);
  }
  if (parts.length > 0) {
    return `Concise and accurate (${parts.join(", ")})`;
  }
  return "Concise and accurate (3–15 lines)";
}

/**
 * システムプロンプトを構築する。
 */
/** Map of language codes to display names for output language instruction. */
const LANG_NAMES = {
  en: "English", ja: "Japanese", zh: "Chinese", ko: "Korean",
  fr: "French", de: "German", es: "Spanish", pt: "Portuguese",
  it: "Italian", ru: "Russian",
};

export function buildTextSystemPrompt(documentStyle, lang) {
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const header = buildPromptHeader(documentStyle, lang);
  const outputRules = t.raw("text.outputRules") || [];
  const langName = LANG_NAMES[lang] || lang;
  return [
    ...header,
    "",
    t("text.instruction"),
    "",
    "## Output Rules (strict)",
    `- Write ALL output strictly in ${langName}. Even if the source code or analysis data contains text in other languages, translate everything into ${langName}.`,
    ...outputRules.map((r) => `- ${r}`),
  ].join("\n");
}

/**
 * 個別ディレクティブ用プロンプトを構築する。
 */
export function buildPrompt(directive, fileName, lines) {
  const directiveLine = directive.line;
  const contextStart = Math.max(0, directiveLine - 20);
  const contextEnd = Math.min(lines.length, directiveLine + 21);
  const surroundingLines = lines.slice(contextStart, contextEnd).join("\n");

  return [
    "## Instructions",
    directive.prompt,
    "",
    `- ${formatLimitRule(directive.params)}`,
    "",
    `## Insertion Context (${fileName})`,
    surroundingLines,
  ].join("\n");
}

/**
 * 解析データをシステムプロンプトに付与する。
 */
export function buildFileSystemPrompt(baseSystemPrompt, contextData, lang) {
  if (!contextData || Object.keys(contextData).length === 0) {
    return baseSystemPrompt;
  }
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const contextJson = JSON.stringify(contextData, null, 2);
  return baseSystemPrompt + "\n\n" + t("text.analysisDataHeading") + "\n" + contextJson;
}

/**
 * バッチプロンプトを構築する。
 * JSON 形式でディレクティブごとの生成テキストを返させる。
 */
export function buildBatchPrompt(fileName, text, textFills, lang) {
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const batchRules = t.raw("text.batchJsonRules") || t.raw("text.batchRules") || [];

  const directiveEntries = textFills.map((d, i) => {
    const id = d.params?.id || `d${i}`;
    const limitInfo = (d.params?.maxLines || d.params?.maxChars)
      ? ` (${formatLimitRule(d.params)})`
      : "";
    return `- id: "${id}" | prompt: "${d.prompt}"${limitInfo}`;
  });

  const defaultRule = `- ${t("text.batchDefaultLimit")}`;

  return [
    t("text.batchInstruction", { fileName }),
    "",
    "## Directives",
    ...directiveEntries,
    "",
    "## File context",
    text,
    "",
    "## Output Rules (strict)",
    ...batchRules.map((r) => `- ${r}`),
    defaultRule,
    `- ${t("text.batchNoHr")}`,
    "",
    "## Output format",
    'Return a JSON object where each key is the directive id and each value is the generated markdown text.',
    'Output ONLY the JSON object. No commentary, no code fences.',
    "",
    `Example: {"d0": "Generated text.", "d1": "Another text."}`,
  ].join("\n");
}
