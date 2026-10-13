#!/usr/bin/env node
/**
 * sennel/docs/commands/scan.js
 *
 * DataSource ベースのスキャンパイプライン。
 * include/exclude glob パターンでファイルを一括収集し、
 * 各 Scannable DataSource の match(relPath) で振り分けて parse(absPath) を実行する。
 *
 * Processing flow:
 *   1. collectFiles(src, include, exclude)
 *   2. Load existing analysis.json (if any)
 *   3. Load Scannable DataSources from preset chain
 *   4. File loop: hash match → skip (preserve entry), mismatch → parse
 *   5. Detect deleted files
 *   6. Generate summaries via AnalysisEntry.summary definitions
 *   7. Save analysis.json
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { parseArgs } from "../../lib/cli.js";
import { Command } from "../../lib/command.js";
import { managedOutputDir } from "../../lib/config.js";
import { collectFiles } from "../lib/scanner.js";
import { loadDataSources } from "../lib/data-source-loader.js";
import { resolveChainSafe, resolveMultiChains } from "../../lib/presets.js";
import { createLogger } from "../../lib/progress.js";
import { translate } from "../../lib/i18n.js";
import { container } from "../../lib/container.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import {
  DocumentationSourceSelection,
} from "../lib/source-selection.js";
import { resolveDocumentationScanPatterns } from "../lib/scan-patterns.js";

import { isEmptyEntry, buildSummary, iterateAnalysisCategories } from "../lib/analysis-entry.js";

const logger = createLogger("scan");

const PRESETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../presets",
);

function resolveScanChains(types, root) {
  try {
    return resolveMultiChains(types, root);
  } catch (err) {
    if (!/Preset not found:/.test(err.message)) throw err;
    return resolveMultiChains(types);
  }
}

function printHelp() {
  const t = translate();
  const h = t.raw("ui:help.cmdHelp.scan");
  const opts = h.options;
  console.log(
    [
      h.usage,
      "",
      h.desc,
      "",
      "Options:",
      `  ${opts.reset}`,
      `  ${opts.stdout}`,
      `  ${opts.dryRun}`,
      `  ${opts.help}`,
    ].join("\n"),
  );
}

/** Load DataSources that have a parse() method (Scannable) */
function loadScanSources(dataDir, existing, presetKey) {
  return loadDataSources(dataDir, {
    existing,
    presetKey,
    onInstance: (instance) => typeof instance.parse === "function",
  });
}

// ---------------------------------------------------------------------------
// Existing analysis helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup from existing analysis: relPath → { entry, category }.
 *
 * @param {Object} existing - existing analysis.json data
 * @returns {Map<string, { entry: Object, category: string }>}
 */
function buildExistingEntryIndex(existing) {
  const index = new Map();
  for (const [cat, catData] of iterateAnalysisCategories(existing)) {
    for (const entry of catData.entries) {
      if (entry && entry.file) {
        if (!index.has(entry.file)) index.set(entry.file, []);
        index.get(entry.file).push({ entry, category: cat });
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Entry ID helpers
// ---------------------------------------------------------------------------

function generateEntryId() {
  return crypto.randomBytes(4).toString("hex");
}

function entrySubkey(entry) {
  if (entry.className) return entry.className;
  if (entry.name) return entry.name;
  return undefined;
}

function entryMatchKey(category, entry) {
  const sub = entrySubkey(entry);
  return sub ? `${category}\0${entry.file}\0${sub}` : `${category}\0${entry.file}`;
}

function buildExistingIdIndex(existing) {
  const index = new Map();
  for (const [cat, catData] of iterateAnalysisCategories(existing)) {
    for (const entry of catData.entries) {
      if (entry && entry.file && entry.id) {
        const key = entryMatchKey(cat, entry);
        index.set(key, entry.id);
      }
    }
  }
  return index;
}

function resolveEntryId(idIndex, category, entry) {
  const key = entryMatchKey(category, entry);
  return idIndex.get(key) || generateEntryId();
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse scan CLI arguments, extracting --reset (optional value) before
 * passing remaining args to parseArgs.
 *
 * @returns {{ cli: Object, reset: string|null, hasReset: boolean }}
 */
function parseScanArgs(rawArgs) {
  const resetIdx = rawArgs.indexOf("--reset");
  let reset = null;
  let hasReset = false;

  const filtered = [...rawArgs];
  if (resetIdx !== -1) {
    hasReset = true;
    const next = rawArgs[resetIdx + 1];
    if (next && !next.startsWith("-")) {
      reset = next;
      filtered.splice(resetIdx, 2);
    } else {
      filtered.splice(resetIdx, 1);
    }
  }

  const cli = parseArgs(filtered, {
    flags: ["--stdout", "--dry-run"],
    defaults: { stdout: false, dryRun: false },
  });
  return { cli, reset, hasReset };
}

// ---------------------------------------------------------------------------
// --reset: clear hashes for specified (or all) categories
// ---------------------------------------------------------------------------

function resetCategories(root, resetValue) {
  const outputDir = managedOutputDir(root);
  const outputPath = path.join(outputDir, "analysis.json");

  if (!fs.existsSync(outputPath)) {
    logger.log("no analysis.json found — nothing to reset");
    return;
  }

  let analysis;
  try {
    analysis = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${outputPath}: ${err.message}`);
  }

  const allCategories = [...iterateAnalysisCategories(analysis)].map(([k]) => k);

  const targets = resetValue
    ? resetValue.split(",").map((s) => s.trim()).filter(Boolean)
    : allCategories;

  let totalEntries = 0;
  let resetCount = 0;

  for (const cat of targets) {
    if (!analysis[cat] || !Array.isArray(analysis[cat].entries)) {
      logger.log(`warn: category "${cat}" not found in analysis.json (skipped)`);
      continue;
    }
    const entries = analysis[cat].entries;
    for (const entry of entries) {
      entry.hash = null;
    }
    logger.log(`reset: ${cat} (${entries.length} entries)`);
    totalEntries += entries.length;
    resetCount++;
  }

  if (resetCount > 0) {
    fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2) + "\n");
    logger.log(`total: ${totalEntries} entries reset in ${resetCount} categories`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runScan(ctx, rawArgs, commandContainer = container) {
  if (!ctx) {
    const { cli, reset, hasReset } = parseScanArgs(rawArgs);
    if (cli.help) {
      printHelp();
      return;
    }
    ctx = resolveDocsContext(commandContainer, cli);
    if (hasReset) {
      resetCategories(ctx.root, reset);
      return;
    }
    ctx.dryRun = cli.dryRun;
    ctx.stdout = cli.stdout;
  }

  const prepared = await prepareDocumentationScan(ctx);
  const { analysis: result, outputDir, outputPath, categoryEntries, dataSources } = prepared;
  const { root } = ctx;
  // 7. Output
  if (ctx.stdout) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (ctx.dryRun) {
    // Summary form: { categoryName: entryCount } for every registered scan DataSource.
    // Zero-match categories are reported as 0 so consumers can distinguish
    // "DataSource not registered" from "registered but matched no files".
    const summary = {};
    for (const name of dataSources.keys()) summary[name] = 0;
    for (const [name, { entries }] of categoryEntries) summary[name] = entries.length;
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
    ctx.aiSession?.recordGeneratedFiles([outputPath]);
    logger.log(`output: ${path.relative(root, outputPath)}`);
  }
  return prepared;
}

export class DocumentationScanPreparation {
  constructor({ analysis, outputDir, outputPath, categoryEntries, dataSources, stats }) {
    this.analysis = analysis;
    this.outputDir = outputDir;
    this.outputPath = outputPath;
    this.categoryEntries = categoryEntries;
    this.dataSources = dataSources;
    this.stats = Object.freeze(stats);
    Object.freeze(this);
  }
}

export async function prepareDocumentationScan(ctx) {
  const { root, srcRoot: src, config: cfg, type } = ctx;

  logger.verbose(`type=${type}`);

  const types = Array.isArray(type) ? type : [type];
  const patterns = resolveDocumentationScanPatterns({ config: cfg, type, root });
  const sourceSelection = new DocumentationSourceSelection(patterns);

  // 1. Collect files with hash/lines/mtime
  const files = collectFiles(src, sourceSelection);
  logger.verbose(`collected ${files.length} files`);

  // 2. Load existing analysis.json
  const outputDir = managedOutputDir(root);
  const outputPath = path.join(outputDir, "analysis.json");
  let existing = null;
  if (!ctx.stdout) {
    if (fs.existsSync(outputPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      } catch (err) {
        throw new Error(`Failed to parse ${outputPath}: ${err.message}`);
      }
    }
  }

  const existingIndex = existing ? buildExistingEntryIndex(existing) : new Map();
  const idIndex = existing ? buildExistingIdIndex(existing) : new Map();
  const currentFilePaths = new Set(files.map((f) => f.relPath));

  // 3. Load Scannable DataSources from preset chain
  const chains = resolveScanChains(types, root);
  const seenDirs = new Set();

  let dataSources = new Map();
  for (const chain of chains) {
    for (const p of chain) {
      if (seenDirs.has(p.dir)) continue;
      seenDirs.add(p.dir);
      dataSources = await loadScanSources(path.join(p.dir, "data"), dataSources, p.key);
    }
  }

  // 3b. DataSource hash detection: clear entry hashes for categories whose DataSource changed
  if (existing) {
    for (const [name, source] of dataSources) {
      const filePath = source._sourceFilePath;
      if (!filePath || !fs.existsSync(filePath)) continue;
      const currentDsHash = crypto.createHash("md5").update(fs.readFileSync(filePath, "utf8")).digest("hex");
      const storedDsHash = existing[name]?.dataSourceHash;
      if (!storedDsHash || storedDsHash !== currentDsHash) {
        const entries = existing[name]?.entries;
        if (Array.isArray(entries) && entries.length > 0) {
          for (const entry of entries) entry.hash = null;
          logger.log(`DataSource changed: ${name} (${entries.length} entries will be re-parsed)`);
        }
      }
    }
  }

  // 4. File loop: per-file hash skip + parse
  // Collect entries per category: Map<categoryName, { entries: [], EntryClass }>
  const categoryEntries = new Map();
  const stats = { unchanged: 0, changed: 0, added: 0, deleted: 0 };

  for (const file of files) {
    // Check if existing entries have matching hash (a file can appear in multiple categories)
    const existingInfos = existingIndex.get(file.relPath) || [];
    const hashMatch = existingInfos.length > 0 && existingInfos.every(({ entry }) => entry.hash === file.hash);

    if (hashMatch) {
      // Hash match → preserve existing entries in all categories (including enrichment)
      for (const { entry, category: cat } of existingInfos) {
        if (!categoryEntries.has(cat)) {
          const source = dataSources.get(cat);
          categoryEntries.set(cat, {
            entries: [],
            EntryClass: source?.constructor?.Entry ?? null,
          });
        }
        if (!entry.id) entry.id = resolveEntryId(idIndex, cat, entry);
        categoryEntries.get(cat).entries.push(entry);
      }
      stats.unchanged++;
      continue;
    }

    // Hash mismatch or new file → try ALL matching DataSources (no break)
    let matched = false;
    for (const [name, source] of dataSources) {
      if (!source.match(file.relPath)) continue;

      const parsed = source.parse(file.absPath);
      if (!parsed) continue;

      // Common layer sets common fields
      parsed.file = file.relPath;
      parsed.hash = file.hash;
      parsed.lines = file.lines;
      parsed.mtime = file.mtime;

      // Empty entry detection
      if (isEmptyEntry(parsed)) continue;

      parsed.id = resolveEntryId(idIndex, name, parsed);

      if (!categoryEntries.has(name)) {
        categoryEntries.set(name, {
          entries: [],
          EntryClass: source.constructor.Entry ?? null,
        });
      }
      categoryEntries.get(name).entries.push(parsed);
      matched = true;
    }

    if (matched) {
      if (existingInfos.length > 0) {
        stats.changed++;
      } else {
        stats.added++;
      }
    }
  }

  // 5. Detect deleted files
  for (const [relPath, infos] of existingIndex) {
    if (!currentFilePaths.has(relPath)) {
      stats.deleted++;
    }
  }

  // 6. Build result with summaries
  const result = { analyzedAt: new Date().toISOString() };

  for (const [name, { entries, EntryClass }] of categoryEntries) {
    const summary = EntryClass ? buildSummary(EntryClass, entries) : { total: entries.length };
    result[name] = { entries, summary };
    // Record DataSource file hash for change detection on next scan
    const source = dataSources.get(name);
    const dsFilePath = source?._sourceFilePath;
    if (dsFilePath && fs.existsSync(dsFilePath)) {
      result[name].dataSourceHash = crypto.createHash("md5").update(fs.readFileSync(dsFilePath, "utf8")).digest("hex");
    }
    logger.verbose(`${name}: ${entries.length} entries`);
  }

  // 6b. Populate usedBy from reverse import lookup
  const fileToEntries = new Map();
  for (const [, { entries }] of categoryEntries) {
    for (const entry of entries) {
      if (entry.file) {
        if (!fileToEntries.has(entry.file)) fileToEntries.set(entry.file, []);
        fileToEntries.get(entry.file).push(entry);
      }
    }
  }
  for (const [, { entries }] of categoryEntries) {
    for (const entry of entries) {
      if (!Array.isArray(entry.imports)) continue;
      for (const imp of entry.imports) {
        // Match import path to known files (resolve relative paths)
        for (const knownFile of fileToEntries.keys()) {
          if (knownFile.endsWith(imp) || knownFile.endsWith(imp.replace(/^\.\//, ""))) {
            for (const target of fileToEntries.get(knownFile)) {
              if (!target.usedBy) target.usedBy = [];
              if (!target.usedBy.includes(entry.file)) {
                target.usedBy.push(entry.file);
              }
            }
          }
        }
      }
    }
  }

  // Preserve enrichedAt if existing entries had enrichment
  if (existing?.enrichedAt) {
    const hasEnrichedEntries = [...categoryEntries.values()].some(
      ({ entries }) => entries.some((e) => e.summary),
    );
    if (hasEnrichedEntries) {
      result.enrichedAt = existing.enrichedAt;
    }
  }

  // Log incremental stats
  if (existing) {
    const parts = [];
    if (stats.changed > 0) parts.push(`${stats.changed} changed`);
    if (stats.added > 0) parts.push(`${stats.added} added`);
    if (stats.deleted > 0) parts.push(`${stats.deleted} deleted`);
    if (stats.unchanged > 0) parts.push(`${stats.unchanged} unchanged`);
    if (parts.length > 0) {
      logger.log(`incremental: ${parts.join(", ")}`);
    }
  }

  return new DocumentationScanPreparation({ analysis: result, outputDir, outputPath, categoryEntries, dataSources, stats });
}

export default class DocsScanCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runScan(ctx.docsCtx, ctx._rawArgs || [], ctx.container);
  }
}
