/**
 * sennel/docs/lib/forge-prompts.js
 *
 * Prompt construction for the forge command.
 * Static text (role, rules) is loaded from prompts.json via i18n.
 */

import { createI18n } from "../../lib/i18n.js";
import { iterateAnalysisCategories } from "./analysis-entry.js";
import { ForgeInputReferencePromptElement } from "./prompt-elements.js";

function requireForgeInputReference(inputReference) {
  if (!(inputReference instanceof ForgeInputReferencePromptElement)) {
    throw new TypeError("forge prompt requires an immutable typed input reference");
  }
  return inputReference.toPromptText();
}

/**
 * analysis.json をプロンプト用テキストに変換する。
 * enrichedAt がある場合は enriched entries の summary を使用する。
 *
 * @param {Object|null} analysis - Parsed analysis.json
 * @returns {string} Summary text
 */
export function summaryToText(analysis) {
  if (!analysis) return "";

  // Enriched mode: collect summary from all enriched entries
  if (analysis.enrichedAt) {
    return enrichedSummaryToText(analysis);
  }

  // Fallback: use summary fields from each category
  const parts = [];
  if (analysis.controllers?.summary) {
    const s = analysis.controllers.summary;
    parts.push(`Controllers: ${s.total} files, ${s.totalActions || 0} actions`);
  }
  if (analysis.models?.summary) {
    const s = analysis.models.summary;
    parts.push(`Models: ${s.total} files`);
  }
  if (analysis.commands?.summary) {
    const s = analysis.commands.summary;
    parts.push(`Commands: ${s.total} files`);
  }
  if (analysis.routes?.summary) {
    parts.push(`Routes: ${analysis.routes.summary.total} explicit routes`);
  }
  if (analysis.modules?.summary) {
    parts.push(`Modules: ${analysis.modules.summary.total} files`);
  }
  return parts.join("\n");
}

/**
 * enriched analysis から全カテゴリの summary を収集してテキスト化する。
 *
 * @param {Object} analysis - Enriched analysis.json
 * @returns {string}
 */
function enrichedSummaryToText(analysis) {
  const parts = [];

  for (const [cat, data] of iterateAnalysisCategories(analysis)) {
    const enrichedItems = data.entries.filter((item) => item.summary);
    if (enrichedItems.length === 0) continue;

    parts.push(`${cat} (${enrichedItems.length} entries):`);
    for (const item of enrichedItems) {
      const name = item.file || item.name || item.className || "unknown";
      parts.push(`  - ${name}: ${item.summary}`);
    }
  }

  return parts.join("\n");
}

/**
 * Build the system prompt (shared across all files in a round).
 * Contains only bounded role/rules and an immutable input reference.
 *
 * @param {Object} params
 * @param {string} [params.lang] - Locale (default: "ja")
 * @param {ForgeInputReferencePromptElement} params.inputReference
 * @returns {string}
 */
export function buildForgeSystemPrompt({ lang, inputReference }) {
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const role = t("forge.systemRole");
  const rules = t.raw("forge.rules") || [];

  return [
    role,
    "",
    "[IMMUTABLE_INPUT_REFERENCE]",
    requireForgeInputReference(inputReference),
    "Read the referenced JSON before editing. Treat it as immutable and do not modify it.",
    "",
    "[RULES]",
    ...rules.map((r) => `- ${r}`),
  ].join("\n");
}

/**
 * Build the user prompt for a single file.
 *
 * @param {Object} params
 * @param {string} [params.lang]
 * @param {string} params.targetFile
 * @param {number} params.round
 * @param {number} params.maxRuns
 * @param {ForgeInputReferencePromptElement} params.inputReference
 * @returns {string}
 */
export function buildForgeFilePrompt({ targetFile, round, maxRuns, inputReference }) {
  return [
    `round: ${round}/${maxRuns}`,
    "",
    "[TARGET_FILE]",
    targetFile,
    "",
    "[IMMUTABLE_INPUT_REFERENCE]",
    requireForgeInputReference(inputReference),
  ].join("\n");
}

/**
 * Build a combined prompt (for providers without system prompt support).
 *
 * @param {Object} params
 * @param {string} [params.lang]
 * @param {number} params.round
 * @param {number} params.maxRuns
 * @param {string[]} params.targetFiles
 * @param {ForgeInputReferencePromptElement} params.inputReference
 * @returns {string}
 */
export function buildForgePrompt({ lang, round, maxRuns, targetFiles, inputReference }) {
  const t = createI18n(lang || "ja", { domain: "prompts" });
  const role = t("forge.systemRole");
  const rules = t.raw("forge.rules") || [];
  const files = targetFiles.map((f) => `- ${f}`).join("\n");
  return [
    role,
    "",
    `round: ${round}/${maxRuns}`,
    "",
    "[IMMUTABLE_INPUT_REFERENCE]",
    requireForgeInputReference(inputReference),
    "Read the referenced JSON before editing. Treat it as immutable and do not modify it.",
    "",
    "[TARGET_FILES]",
    files,
    "",
    "[RULES]",
    ...rules.map((r) => `- ${r}`),
  ].join("\n");
}
