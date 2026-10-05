/**
 * src/flow/lib/get-context.js
 *
 * Retrieve analysis context in various modes:
 * - File mode (ctx.filePath): return file content
 * - Search mode (ctx.searchQuery): keyword search in analysis entries
 * - List mode (default): return filtered analysis entries
 *
 * ctx.filePath    — file path relative to root (file mode)
 * ctx.searchQuery — search query string (search mode)
 */

import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { managedOutputDir, loadConfig } from "../../lib/config.js";
import { FlowCommand } from "./base-command.js";
import { iterateAnalysisCategories } from "../../docs/lib/analysis-entry.js";
import { container } from "../../lib/container.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  AtomicPromptElement, PromptInputBuilder, PromptRequestEnvelope, PromptRequestLimit,
  PromptBatchPlan, PromptBatchExecutor, PromptBatchReducer, PromptResponseCoverageInvalidFailure,
} from "../../lib/prompt-batching.js";

const EXCLUDE_FIELDS = new Set(["hash", "mtime", "lines", "id", "enrich", "detail"]);

function toSearchResult(e) {
  return {
    file: e.file,
    summary: e.summary || null,
    keywords: e.keywords,
    chapter: e.chapter || null,
    role: e.role || null,
  };
}

/**
 * Search analysis entries by keyword matching against the keywords array.
 * @param {Object[]} entries - Analysis entries (with keywords, summary, detail, etc.)
 * @param {string} query - Search query string
 * @returns {Object[]} Matched entries with file, summary, detail, keywords, chapter, role
 */
function searchEntries(entries, query) {
  const q = query.toLowerCase();
  return entries
    .filter((e) => {
      if (!Array.isArray(e.keywords)) return false;
      return e.keywords.some((kw) => String(kw).toLowerCase().includes(q));
    })
    .map((e) => toSearchResult(e));
}

/**
 * Collect all unique keywords from analysis.json entries.
 * @param {Object} analysis - Parsed analysis.json
 * @returns {string[]} Unique keywords array
 */
function collectAllKeywords(analysis, limit = 0) {
  const freq = new Map();
  for (const [, catData] of iterateAnalysisCategories(analysis)) {
    for (const e of catData.entries) {
      if (!Array.isArray(e.keywords)) continue;
      for (const kw of e.keywords) {
        const s = String(kw);
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    }
  }
  // Sort by frequency descending, then alphabetically for stability
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kw]) => kw);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/**
 * Build a prompt for AI keyword selection.
 * @param {string[]} keywords - Available keywords from analysis
 * @param {string} query - User's natural language query
 * @returns {string} Prompt text
 */
const KEYWORD_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["keywords"],
  additionalProperties: false,
};

const KEYWORD_SELECTION_FMT_FALLBACK = 'Return ONLY a JSON object with a keywords array. No explanation, no markdown fences.\nExample output: {"keywords":["auth","認証","session","login"]}';

function buildKeywordSelectionPrompt(keywords, query) {
  const pb = _buildKeywordSelectionPb(keywords, query);
  const built = pb.build();
  const parts = [];
  if (built.systemPrompt) parts.push(built.systemPrompt);
  if (built.fmtFallback) parts.push(built.fmtFallback);
  if (built.userPrompt) parts.push(built.userPrompt);
  return parts.join("\n\n");
}

function _buildKeywordSelectionPb(keywords, query) {
  const pb = new PromptBuilder();
  pb.setRole("You are a keyword selector. Given a query and a list of available keywords, select the keywords that are relevant to the query.");

  const rules = [
    "- Select 5-20 keywords that are most relevant to the query.",
    "- Include both direct matches and semantically related keywords.",
  ].join("\n");
  pb.setRules(rules);
  pb.setJsonSchema(KEYWORD_SELECTION_SCHEMA);
  pb.setFmtFallback(KEYWORD_SELECTION_FMT_FALLBACK);

  pb.addUserPrompt("## Query", query);
  pb.addUserPrompt("## Available keywords", keywords.join(", "));

  return pb;
}

class KeywordSelectionEnvelope extends PromptRequestEnvelope {
  constructor(query) {
    super();
    this.query = query;
  }

  build(elements) {
    return _buildKeywordSelectionPb(elements.map((element) => element.toPromptText()), this.query).build();
  }
}

class SelectedKeywordResult {
  constructor(raw, batch) {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    const selected = parsed.keywords;
    const allowed = new Set(batch.elements.map((element) => element.toPromptText()));
    if (!Array.isArray(selected) || selected.some((keyword) => typeof keyword !== "string" || !allowed.has(keyword))) {
      throw new PromptResponseCoverageInvalidFailure("Keyword selection contains an unknown keyword");
    }
    this.keywords = Object.freeze([...new Set(selected)]);
    Object.freeze(this);
  }
}

class SelectedKeywordReducer extends PromptBatchReducer {
  reduce(completions) {
    return [...new Set(completions.flatMap((completion) => completion.response.keywords))];
  }
}

/**
 * Fallback search: split query by spaces, OR-match against keywords.
 * @param {Object[]} entries - Analysis entries
 * @param {string} query - Space-separated keywords
 * @returns {Object[]} Matched entries (deduplicated)
 */
function fallbackSearch(entries, query) {
  const terms = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  if (terms.length === 0) return [];
  const seen = new Set();
  const results = [];
  for (const e of entries) {
    if (!Array.isArray(e.keywords)) continue;
    const match = terms.some((t) =>
      e.keywords.some((kw) => String(kw).toLowerCase().includes(t))
    );
    if (match && !seen.has(e.file)) {
      seen.add(e.file);
      results.push(toSearchResult(e));
    }
  }
  return results;
}

const NGRAM_THRESHOLD = 0.6;
const NGRAM_MIN_RESULTS = 5;
const NGRAM_MAX_RESULTS = 30;
const HUB_CONNECTION_THRESHOLD = 20;

function toBigrams(text) {
  const s = text.toLowerCase();
  if (s.length < 2) return [];
  const bigrams = [];
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.push(s.slice(i, i + 2));
  }
  return bigrams;
}

function bigramSimilarity(a, b) {
  if (a.length === 0 || b.length === 0) return 0.0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

function ngramSearch(allEntries, query) {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const wordBigrams = words.map((w) => toBigrams(w));
  if (wordBigrams.every((bg) => bg.length === 0)) return [];

  let maxImports = 0;
  let maxMethods = 0;
  for (const e of allEntries) {
    const ic = Array.isArray(e.imports) ? e.imports.length : 0;
    const mc = Array.isArray(e.methods) ? e.methods.length : 0;
    if (ic > maxImports) maxImports = ic;
    if (mc > maxMethods) maxMethods = mc;
  }

  const scored = [];
  for (const e of allEntries) {
    if (!Array.isArray(e.keywords) || e.keywords.length === 0) continue;

    let matchCount = 0;
    let totalSim = 0;
    for (const wbg of wordBigrams) {
      if (wbg.length === 0) continue;
      let bestSim = 0;
      for (const kw of e.keywords) {
        const sim = bigramSimilarity(wbg, toBigrams(String(kw)));
        if (sim > bestSim) bestSim = sim;
      }
      if (bestSim >= NGRAM_THRESHOLD) {
        matchCount++;
        totalSim += bestSim;
      }
    }

    if (matchCount === 0) continue;

    const ic = Array.isArray(e.imports) ? e.imports.length : 0;
    const mc = Array.isArray(e.methods) ? e.methods.length : 0;
    const importBonus = maxImports > 0 ? (ic / maxImports) * 0.5 : 0;
    const methodBonus = maxMethods > 0 ? (mc / maxMethods) * 0.3 : 0;
    const score = totalSim + matchCount + importBonus + methodBonus;

    scored.push({ entry: e, score, matchCount });
  }

  const multiMatch = scored.filter((s) => s.matchCount >= 2);
  const singleMatch = scored.filter((s) => s.matchCount === 1);
  singleMatch.sort((a, b) => b.score - a.score);

  let results = [...multiMatch];
  for (const s of singleMatch) {
    if (results.length >= NGRAM_MAX_RESULTS) break;
    results.push(s);
  }

  if (results.length < NGRAM_MIN_RESULTS) {
    for (const s of singleMatch) {
      if (results.includes(s)) continue;
      results.push(s);
      if (results.length >= NGRAM_MIN_RESULTS) break;
    }
  }

  results = results.slice(0, NGRAM_MAX_RESULTS);
  results.sort((a, b) => b.score - a.score);

  return results.map(({ entry, score }) => {
    const sr = toSearchResult(entry);
    sr.score = score;
    return sr;
  });
}

/**
 * AI-powered keyword selection + static match search.
 * Falls back to space-split OR search if agent is unavailable.
 * @param {Object[]} allEntries - All analysis entries
 * @param {Object} analysis - Full analysis object (for keyword collection)
 * @param {string} query - Natural language query
 * @param {string} root - Project root path
 * @returns {Object[]} Matched entries
 */
async function aiSearch(allEntries, analysis, query, _root) {
  const allKeywords = collectAllKeywords(analysis);
  if (allKeywords.length === 0) return fallbackSearch(allEntries, query);

  const agent = container.get("agent");
  if (!agent.resolve("flow.context.search")) return fallbackSearch(allEntries, query);

  let selectedKeywords;
  try {
    const limit = new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit ?? 120_000 });
    const envelope = new KeywordSelectionEnvelope(query);
    const builder = new PromptInputBuilder({ envelope, limit });
    allKeywords.forEach((keyword, sequence) => builder.add(new AtomicPromptElement({
      id: `keyword:${sequence}`, sequence, text: keyword,
      sourceRevision: createHash("sha256").update(keyword).digest("hex"),
    })));
    const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
    selectedKeywords = await new PromptBatchExecutor().execute({
      plan,
      callAgent: (built, _batch, _retryIndex, _attempt, providerCallAdmission) => agent.call(built.userPrompt, {
        ...built, commandId: "flow.context.search", providerCallAdmission,
      }),
      projectInvocation: typeof agent.projectInvocation === "function"
        ? (built) => agent.projectInvocation(built.userPrompt, { ...built, commandId: "flow.context.search" })
        : undefined,
      responseContract: { parse: (raw, batch) => new SelectedKeywordResult(raw, batch) },
      reducer: new SelectedKeywordReducer(),
    });
  } catch (err) {
    process.stderr.write(`[sennel] context aiSearch failed: ${err.message}\n`);
    return fallbackSearch(allEntries, query);
  }

  // Use selected keywords for OR search
  if (selectedKeywords.length === 0) return fallbackSearch(allEntries, query);

  const terms = selectedKeywords.map((k) => String(k).toLowerCase());
  const seen = new Set();
  const results = [];
  for (const e of allEntries) {
    if (!Array.isArray(e.keywords)) continue;
    const match = terms.some((t) =>
      e.keywords.some((kw) => String(kw).toLowerCase().includes(t))
    );
    if (match && !seen.has(e.file)) {
      seen.add(e.file);
      results.push(toSearchResult(e));
    }
  }
  // If AI-selected keywords matched nothing, fall back to text search
  if (results.length === 0) return fallbackSearch(allEntries, query);
  return results;
}

/**
 * Dispatch search based on configured mode with fallback chain.
 * - ngram mode: ngramSearch → fallbackSearch → aiSearch
 * - ai mode: aiSearch → fallbackSearch (legacy behavior)
 * @param {Object[]} allEntries - All analysis entries
 * @param {Object} analysis - Full analysis object
 * @param {string} query - Search query
 * @param {string} root - Project root path
 * @param {string} mode - Search mode ("ngram" or "ai")
 * @returns {Object[]} Matched entries
 */
function isHub(entry) {
  const ic = Array.isArray(entry.imports) ? entry.imports.length : 0;
  const uc = Array.isArray(entry.usedBy) ? entry.usedBy.length : 0;
  return (ic + uc) >= HUB_CONNECTION_THRESHOLD;
}

function _postProcess(results, allEntries, options) {
  const seen = new Set(results.map((r) => r.file));
  const scoreMap = new Map();
  for (const r of results) {
    scoreMap.set(r.file, r.score || 0);
  }

  if (Array.isArray(options.scopePaths)) {
    const entryMap = new Map(allEntries.map((e) => [e.file, e]));
    let maxImports = 0;
    let maxMethods = 0;
    for (const e of allEntries) {
      const ic = Array.isArray(e.imports) ? e.imports.length : 0;
      const mc = Array.isArray(e.methods) ? e.methods.length : 0;
      if (ic > maxImports) maxImports = ic;
      if (mc > maxMethods) maxMethods = mc;
    }
    for (const sp of options.scopePaths) {
      if (seen.has(sp)) continue;
      const entry = entryMap.get(sp);
      if (!entry) continue;
      const sr = toSearchResult(entry);
      const ic = Array.isArray(entry.imports) ? entry.imports.length : 0;
      const mc = Array.isArray(entry.methods) ? entry.methods.length : 0;
      const importBonus = maxImports > 0 ? (ic / maxImports) * 0.5 : 0;
      const methodBonus = maxMethods > 0 ? (mc / maxMethods) * 0.3 : 0;
      sr.score = importBonus + methodBonus;
      results.push(sr);
      seen.add(sp);
      scoreMap.set(sp, sr.score);
    }
  }

  if (options.expandImports) {
    const entryMap = new Map(allEntries.map((e) => [e.file, e]));
    const directMatchFiles = new Set(seen);
    for (const file of directMatchFiles) {
      const entry = entryMap.get(file);
      if (!entry || !Array.isArray(entry.imports)) continue;
      const parentScore = scoreMap.get(file) || 0;
      for (const imp of entry.imports) {
        if (seen.has(imp)) continue;
        const impEntry = entryMap.get(imp);
        if (!impEntry) continue;
        if (isHub(impEntry)) continue;
        const sr = toSearchResult(impEntry);
        sr.score = parentScore * 0.5;
        results.push(sr);
        seen.add(imp);
        scoreMap.set(imp, sr.score);
      }
    }
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results;
}

function contextSearch(allEntries, analysis, query, root, mode = "ngram", options = {}) {
  if (mode === "ai") {
    return aiSearch(allEntries, analysis, query, root);
  }

  let results = ngramSearch(allEntries, query);
  if (results.length === 0) {
    results = fallbackSearch(allEntries, query);
  }

  const processed = _postProcess(results, allEntries, options);

  if (processed.length === 0) {
    return aiSearch(allEntries, analysis, query, root);
  }

  return processed;
}

function filterEntry(entry) {
  const filtered = {};
  for (const [k, v] of Object.entries(entry)) {
    if (EXCLUDE_FIELDS.has(k)) continue;
    filtered[k] = v;
  }
  if (!filtered.summary) {
    filtered.needsSource = true;
  }
  return filtered;
}

/**
 * Load and flatten all analysis entries from analysis.json.
 * @param {string} root - Project root path
 * @returns {{ analysis: Object, entries: Object[] }}
 */
function loadAnalysisEntries(root) {
  const outputDir = managedOutputDir(root);
  const analysisPath = path.join(outputDir, "analysis.json");

  if (!fs.existsSync(analysisPath)) {
    throw new Error("analysis.json not found. Run: sennel docs scan");
  }

  let analysis;
  try {
    analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse analysis.json: ${e.message}`);
  }

  const entries = [];
  for (const [, catData] of iterateAnalysisCategories(analysis)) {
    for (const entry of catData.entries) {
      entries.push(entry);
    }
  }

  return { analysis, entries };
}

export default class GetContextCommand extends FlowCommand {
  async execute(ctx) {
    const { root } = ctx;
    const filePath = ctx.filePath || ctx.path || null;
    const searchQuery = ctx.searchQuery || ctx.search || null;

    // File mode
    if (filePath) {
      const absPath = path.resolve(root, filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`file not found: ${filePath}`);
      }

      const isDocsPath = filePath.startsWith("docs/") || filePath.startsWith("docs\\");
      const content = fs.readFileSync(absPath, "utf8");

      return {
        path: filePath,
        type: isDocsPath ? "docs" : "src",
        content,
      };
    }

    // Search mode
    if (searchQuery) {
      const { analysis, entries: allEntries } = loadAnalysisEntries(root);

      let config;
      try { config = loadConfig(root); } catch (_e) { config = {}; }
      const searchMode = config?.flow?.commands?.context?.search?.mode ?? "ngram";
      const results = await contextSearch(allEntries, analysis, searchQuery, root, searchMode);

      return {
        total: results.length,
        entries: results,
      };
    }

    // List mode
    const { entries: allEntries } = loadAnalysisEntries(root);
    const filtered = allEntries.map((entry) => filterEntry(entry));

    return {
      total: filtered.length,
      entries: filtered,
    };
  }
}

export { filterEntry, searchEntries, collectAllKeywords, buildKeywordSelectionPrompt, fallbackSearch, toBigrams, bigramSimilarity, ngramSearch, loadAnalysisEntries, contextSearch };
