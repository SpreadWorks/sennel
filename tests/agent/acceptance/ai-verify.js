import { testTemporaryRoot } from "../../test-environment.js";
/**
 * tests/agent/acceptance/ai-verify.js
 *
 * AI-based quality verification for generated docs.
 * Evaluates documentation quality on 5 axes:
 *   Naturalness, Cultural Fit, Informativeness, Coherence, Actionability
 */

import fs from "fs";
import path from "path";
import assert from "node:assert/strict";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { getChapterFiles } from "../../../src/docs/lib/command-context.js";

const QUALITY_AXES = [
  "naturalness",
  "culturalFit",
  "informativeness",
  "coherence",
  "actionability",
];

/**
 * Build the verification prompt for the AI.
 *
 * @param {string} docsContent - Concatenated docs content
 * @param {string} fixtureDescription - Description of the fixture for context
 * @param {string} lang - Documentation language code
 * @returns {string}
 */
function buildVerifyPrompt(docsContent, fixtureDescription, lang) {
  return [
    "You are a documentation quality reviewer.",
    "",
    "## Fixture Description",
    fixtureDescription,
    "",
    "## Generated Documentation",
    `Language: ${lang}`,
    docsContent,
    "",
    "## Verification Instructions",
    "Evaluate the generated documentation on the following 5 axes.",
    "For each axis, determine pass/fail and provide a brief comment explaining your assessment.",
    "",
    "1. **naturalness** — Does the text read naturally, as if written by a human?",
    "   Is it free of robotic, template-like, or formulaic phrasing?",
    "   Fail if the text feels machine-generated or overly mechanical.",
    "",
    "2. **culturalFit** — Does the text follow the conventions of technical writing",
    `   in the target language (${lang})? For example: consistent register (formal/informal),`,
    "   appropriate use of language-specific conventions (e.g. 'ですます調' consistency in Japanese,",
    "   imperative mood in English CLI docs). Fail if conventions are violated or mixed inconsistently.",
    "",
    "3. **informativeness** — Does the text provide project-specific, concrete information?",
    "   Is it more than generic filler? Does it reference actual files, classes, commands,",
    "   or architectural decisions from the project? Fail if content is too vague or generic.",
    "",
    "4. **coherence** — Is terminology consistent across chapters? Do sections flow logically?",
    "   Are there contradictions or unnecessary repetition? Fail if there are contradictions",
    "   or if chapters feel disconnected.",
    "",
    "5. **actionability** — Can a developer reading this documentation understand where to start,",
    "   how the project is structured, and what to do next? Are entry points and key files clear?",
    "   Fail if the documentation doesn't help a developer get oriented.",
    "",
    "## Output Format",
    "Return ONLY a JSON object (no markdown fences, no explanation):",
    "{",
    '  "pass": <overall boolean — true only if ALL axes pass>,',
    '  "naturalness": { "pass": true/false, "comment": "..." },',
    '  "culturalFit": { "pass": true/false, "comment": "..." },',
    '  "informativeness": { "pass": true/false, "comment": "..." },',
    '  "coherence": { "pass": true/false, "comment": "..." },',
    '  "actionability": { "pass": true/false, "comment": "..." }',
    "}",
    "",
    "Be lenient: pass unless there are clear, significant problems.",
  ].join("\n");
}

/**
 * Build a description of the fixture for the AI.
 *
 * @param {string} tmp - Fixture root directory
 * @param {string} presetName - Preset name
 * @returns {string}
 */
function buildFixtureDescription(tmp, presetName) {
  const parts = [`Preset: ${presetName}`];

  // List source files
  const srcFiles = [];
  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        srcFiles.push(rel);
      }
    }
  }

  // Scan common source directories
  for (const dir of ["src", "app", "routes", "config", "database", "migrations"]) {
    walk(path.join(tmp, dir), dir);
  }

  if (srcFiles.length > 0) {
    parts.push(`\nSource files (${srcFiles.length}):`);
    for (const f of srcFiles) parts.push(`- ${f}`);
  }

  // Package info
  for (const pkgFile of ["package.json", "composer.json"]) {
    const pkgPath = path.join(tmp, pkgFile);
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf8");
      parts.push(`\n${pkgFile}:`);
      parts.push(content);
    }
  }

  return parts.join("\n");
}

/**
 * Parse the AI response JSON, handling markdown fences.
 *
 * @param {string} response - Raw AI response
 * @returns {Object} Parsed JSON
 */
function parseAIResponse(response) {
  let cleaned = response.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`AI returned unparseable response: ${response.slice(0, 500)}`);
  }
}

/**
 * Print quality evaluation results to console.
 *
 * @param {string} presetName - Preset name
 * @param {Object} result - Parsed AI evaluation result
 */
function printQualityReport(presetName, result) {
  console.log(`\n  [quality] AI evaluation for "${presetName}":`);
  for (const axis of QUALITY_AXES) {
    const eval_ = result[axis];
    if (!eval_) continue;
    const icon = eval_.pass ? "✓" : "✗";
    console.log(`    ${icon} ${axis}: ${eval_.comment || "(no comment)"}`);
  }
  console.log();
}

/**
 * Extract structured quality data from the AI result.
 *
 * @param {Object} result - Parsed AI evaluation result
 * @returns {Object} Quality data for report JSON
 */
export function extractQualityData(result) {
  const quality = {};
  for (const axis of QUALITY_AXES) {
    const eval_ = result[axis];
    quality[axis] = eval_
      ? { pass: Boolean(eval_.pass), comment: eval_.comment || "" }
      : { pass: false, comment: "axis not evaluated by AI" };
  }
  return quality;
}

/**
 * Run AI quality verification on generated docs.
 *
 * @param {string} tmp - Project root
 * @param {Object} config - ProjectConfig
 * @param {string} presetName - Preset name for context
 * @returns {{ quality: Object }} Evaluation results (throws on failure)
 */
export async function verifyWithAI(tmp, config, presetName) {
  const registry = new ProviderRegistry(config?.agent?.providers || {});
  const paths = { root: tmp, agentWorkDir: path.join(tmp, ".tmp") };
  const agent = new Agent({ config, paths, registry, logger: new Logger({ logDir: testTemporaryRoot().path, enabled: false }) });
  if (!agent.resolve()) {
    throw new Error("No agent configured. Set 'agent.default' in config.json.");
  }
  const docsDir = path.join(tmp, "docs");
  const files = getChapterFiles(docsDir);
  const lang = config.docs?.defaultLanguage || config.lang || "en";

  // Concatenate all docs
  const docsContent = files
    .map((f) => {
      const content = fs.readFileSync(path.join(docsDir, f), "utf8");
      return `--- ${f} ---\n${content}`;
    })
    .join("\n\n");

  // Also include README if it exists
  const readmePath = path.join(tmp, "README.md");
  const readmeContent = fs.existsSync(readmePath)
    ? `\n\n--- README.md ---\n${fs.readFileSync(readmePath, "utf8")}`
    : "";

  const fullDocs = docsContent + readmeContent;
  const fixtureDesc = buildFixtureDescription(tmp, presetName);
  const prompt = buildVerifyPrompt(fullDocs, fixtureDesc, lang);

  const response = await agent.call(prompt, {});

  let result;
  try {
    result = parseAIResponse(response);
  } catch (e) {
    assert.fail(e.message);
  }

  const quality = extractQualityData(result);
  printQualityReport(presetName, result);

  // Maintain existing pass/fail assertion behavior
  if (!result.pass) {
    const failedAxes = QUALITY_AXES.filter((a) => result[a] && !result[a].pass);
    const details = failedAxes
      .map((a) => `${a}: ${result[a].comment || "failed"}`)
      .join("\n  - ");
    const err = new assert.AssertionError({
      message: `AI quality check failed for ${presetName}:\n  - ${details}`,
      operator: "fail",
    });
    err.quality = quality;
    throw err;
  }

  return { quality };
}
