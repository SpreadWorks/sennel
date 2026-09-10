#!/usr/bin/env node
/**
 * sennel/forge/forge.js
 *
 * Prompt 起点で docs 改善を反復する。
 * 1) AI に generated docs(01..10) を更新させる
 * 2) docs:generate を実行
 * 3) docs:review を実行
 * 4) NG の場合は失敗内容を次ラウンドへフィードバックして再実行
 *
 * 途中でコード外情報が必要な場合、AI は `NEEDS_INPUT` を出力し、処理を中断する。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runCmdAsync } from "../../lib/process.js";
import { populateFromAnalysis } from "./data.js";
import { textFillFromAnalysis } from "./text.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { PKG_DIR, parseArgs } from "../../lib/cli.js";
import { resolveConcurrency, resolveWorkDir } from "../../lib/config.js";
import { Command } from "../../lib/command.js";
import { loadFullAnalysis, loadAnalysisData, getChapterFiles, readText } from "../lib/command-context.js";
import { createResolver } from "../lib/resolver-factory.js";
import { container } from "../../lib/container.js";
import { translate } from "../../lib/i18n.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { DocumentationAgent } from "../lib/documentation-agent.js";
import { EXIT_ERROR } from "../../lib/constants.js";
import { loadSpecJson, specJsonToPromptText } from "../../lib/spec-json.js";
import { AtomicFile } from "../../lib/atomic-file.js";
import { ForgeInputReferencePromptElement } from "../lib/prompt-elements.js";
import {
  summaryToText,
  buildForgeSystemPrompt,
  buildForgeFilePrompt,
  buildForgePrompt,
} from "../lib/forge-prompts.js";
import {
  summarizeReview,
  parseFileResults,
} from "../lib/review-parser.js";

const DEFAULT_WAIT_LOG_SEC = 1;
const DEFAULT_MAX_RUNS = 3;
const DEFAULT_REVIEW_CMD = "sennel docs review";
const DEFAULT_MODE = "local";

function getTargetFiles(root, type, configChapters) {
  const docsDir = path.join(root, "docs");
  return getChapterFiles(docsDir, { type, configChapters, projectRoot: root }).map((f) => `docs/${f}`);
}

/**
 * spec テキストから関連する章ファイルを推定する。
 * 章ファイル名のキーワード（拡張子除去）と spec テキストを
 * 大文字小文字無視でマッチングする。
 *
 * @param {string} specText - spec.json から生成したプロンプト用テキスト
 * @param {string[]} allFiles - 全章ファイルパス (例: ["docs/overview.md", ...])
 * @returns {string[]} 関連ファイルリスト（空の場合は推定失敗 = 全ファイル対象）
 */
function estimateRelevantFiles(specText, allFiles) {
  if (!specText) return [];
  const specLower = specText.toLowerCase();
  const matched = [];
  for (const file of allFiles) {
    // "docs/overview.md" → "overview"
    const baseName = path.basename(file, ".md");
    // "cli_commands" → ["cli", "commands"]
    const keywords = baseName.split("_").filter(Boolean);
    // All keywords must appear in spec text
    const allMatch = keywords.every((kw) => specLower.includes(kw.toLowerCase()));
    if (allMatch) {
      matched.push(file);
    }
  }
  return matched;
}

function parseCliOptions(argv) {
  const opts = parseArgs(argv, {
    flags: ["--verbose", "--dry-run"],
    options: ["--prompt", "--prompt-file", "--spec", "--max-runs", "--review-cmd", "--mode"],
    aliases: { "-v": "--verbose" },
    defaults: {
      prompt: "",
      promptFile: "",
      spec: "",
      verbose: false,
      dryRun: false,
      maxRuns: String(DEFAULT_MAX_RUNS),
      reviewCmd: DEFAULT_REVIEW_CMD,
      mode: DEFAULT_MODE,
    },
  });
  if (!opts.help) {
    const n = Number(opts.maxRuns);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--max-runs must be > 0");
    }
    opts.maxRuns = Math.floor(n);
    if (!["local", "assist", "agent"].includes(opts.mode)) {
      throw new Error("--mode must be one of: local, assist, agent");
    }
  }
  return opts;
}

function printHelp() {
  const t = translate();
  const h = t.raw("ui:help.cmdHelp.forge");
  const o = h.options;
  console.log(
    [
      h.usage, "", "Options:",
      `  ${o.prompt}`, `  ${o.promptFile}`, `  ${o.spec}`, `  ${o.maxRuns}`,
      `  ${o.reviewCmd}`, `  ${o.mode}`, `  ${o.dryRun}`,
      `  ${o.verbose}`, `  ${o.help}`,
      "", "Per-file mode:", `  ${h.perFileNote}`, "",
    ].join("\n")
  );
}

/**
 * コマンド文字列をコマンドと引数に分割して実行する。
 * bash に依存しない。
 */
function runCommand(cmdString, cwd) {
  const parts = cmdString.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const command = parts[0];
  const args = parts.slice(1).map((s) => s.replace(/^["']|["']$/g, ""));
  return runCmdAsync(command, args, { cwd });
}

/**
 * Thin wrapper around callAgentAsync that adds forge-specific UI:
 * label logging and a progress ticker.
 */
async function invokeAgent(agent, prompt, { systemPrompt, verbose, label }) {
  const displayLabel = label || "agent";
  console.log(`[agent] ${displayLabel} started`);

  const ticker = !verbose
    ? setInterval(() => process.stderr.write("."), DEFAULT_WAIT_LOG_SEC * 1000)
    : null;

  const pb = new PromptBuilder();
  if (systemPrompt) pb.setRole(systemPrompt);
  pb.addUserPrompt("## Content", prompt);
  const built = pb.build();

  try {
    return await DocumentationAgent.from(agent).call(built.userPrompt, {
      commandId: "docs.forge",
      systemPrompt: built.systemPrompt,
      onStdout: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
      onStderr: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
    });
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

export function materializeForgeInputReference(root, config, input) {
  const serialized = JSON.stringify(input, null, 2) + "\n";
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  const inputDir = path.join(resolveWorkDir(root, config), "forge-inputs");
  const inputPath = path.join(inputDir, `${digest}.json`);
  fs.mkdirSync(inputDir, { recursive: true });
  if (fs.existsSync(inputPath)) {
    const current = fs.readFileSync(inputPath, "utf8");
    if (current !== serialized) throw new Error(`forge input digest collision: ${inputPath}`);
  } else {
    new AtomicFile(inputPath).write(Buffer.from(serialized));
  }
  return new ForgeInputReferencePromptElement({
    id: `forge-input:${digest}`,
    sourceRevision: digest,
    sequence: 0,
    path: path.relative(root, inputPath),
    digest,
    byteLength: Buffer.byteLength(serialized),
    authorization: "read-only",
  });
}

/**
 * Run agent for each file with concurrency control.
 * Returns an array of { file, ok, error? } results.
 */
async function runPerFile({ agent, targetFiles, systemPrompt, inputReference, round, maxRuns, concurrency, verbose }) {
  const raw = await mapWithConcurrency(targetFiles, concurrency, async (file) => {
    const filePrompt = buildForgeFilePrompt({
      targetFile: file,
      round,
      maxRuns,
      inputReference,
    });

    console.log(`[forge] start: ${file}`);

    await invokeAgent(agent, filePrompt, {
      label: `forge:${path.basename(file)}`,
      verbose,
      systemPrompt,
    });

    console.log(`[forge] done: ${file}`);
    return { file, ok: true };
  });

  return raw.map((r, i) => {
    if (r.error) {
      const file = targetFiles[i];
      console.log(`[forge] failed: ${file} — ${String(r.error.message || r.error).slice(0, 200)}`);
      return { file, ok: false, error: r.error.message };
    }
    return r.value;
  });
}

async function runForge(rawArgs, container) {
  const cli = parseCliOptions(rawArgs);
  if (cli.help) {
    printHelp();
    return;
  }

  const root = container.get("root");
  const config = container.get("config");
  const type = config?.type || "";
  const lang = config?.docs?.defaultLanguage;
  const t = translate();
  const agent = container.get("agent");
  const hasAgent = !!agent.resolve("docs.forge");
  const mode = cli.mode || DEFAULT_MODE;

  if (mode === "agent" && !hasAgent) {
    throw new Error(
      "forge: --mode=agent requires a configured provider (defaultAgent or --agent)",
    );
  }

  const analysisData = loadFullAnalysis(root);
  const analysisSummary = summaryToText(analysisData);
  if (analysisData && !cli.dryRun) {
    console.log("[forge] analysis data loaded.");
    let resolveFn = null;
    try {
      const resolver = await createResolver(type, root, { configChapters: config.chapters });
      resolveFn = (preset, source, method, analysis, labels, params) => resolver.resolve(preset, source, method, analysis, labels, params);
    } catch (err) {
      console.log(`[forge] WARN: resolver not available (${err.message}), skipping {{data}} population`);
    }
    const populateResult = populateFromAnalysis(root, analysisData, resolveFn, { type, configChapters: config.chapters });
    if (populateResult.populated) {
      console.log(`[forge] populated placeholders in: ${populateResult.files.join(", ")}`);
    }
    if (agent) {
      const tfResult = await textFillFromAnalysis(root, analysisData, "docs.text", undefined);
      if (tfResult.filled > 0) {
        console.log(`[forge] {{text}}: ${tfResult.filled} directives resolved`);
      }
    }
  } else if (analysisData && cli.dryRun) {
    console.log("[forge] DRY-RUN: skipping {{data}} population and {{text}} fill");
  }

  let userPrompt = String(cli.prompt || "").trim();
  if (!userPrompt && cli.promptFile) {
    userPrompt = readText(path.resolve(root, cli.promptFile)).trim();
  }
  if (!userPrompt) {
    throw new Error(t("messages:forge.promptRequired"));
  }
  let specPath = "";
  let specText = "";
  if (cli.spec) {
    specPath = path.resolve(root, cli.spec);
    if (!fs.existsSync(specPath)) {
      throw new Error(t("messages:forge.specNotFound", { path: specPath }));
    }
    // spec 207 / T8: read structured spec.json and flatten into the prompt
    // text. Throws if spec.json is missing or invalid (no spec.md fallback).
    const spec = loadSpecJson(specPath);
    specText = specJsonToPromptText(spec).trim();
  }

  const effectiveMaxRuns = cli.dryRun ? 1 : cli.maxRuns;

  console.log(
    [
      "",
      "=== forge ===",
      `maxRuns: ${effectiveMaxRuns}${cli.dryRun ? " (dry-run)" : ""}`,
      `mode: ${mode}`,
      `review: ${cli.dryRun ? "(skipped)" : cli.reviewCmd}`,
      specPath ? `spec: ${path.relative(root, specPath)}` : "spec: (not set)",
      "",
    ].join("\n")
  );

  if (cli.dryRun) {
    console.log("[forge] DRY-RUN: target files:");
    for (const f of getTargetFiles(root, type, config.chapters)) {
      console.log(`  - ${f}`);
    }
    console.log("[forge] DRY-RUN: no files written, no review, no agent calls.");
    console.log("\n=== DONE (dry-run) ===");
    return;
  }

  const concurrency = resolveConcurrency(config);

  // Spec-based file estimation: narrow target files if spec is provided
  const allTargetFiles = getTargetFiles(root, type, config.chapters);
  let initialTargetFiles = allTargetFiles;
  if (specText) {
    const estimated = estimateRelevantFiles(specText, allTargetFiles);
    if (estimated.length > 0 && estimated.length < allTargetFiles.length) {
      initialTargetFiles = estimated;
      console.log(`[forge] spec-based estimation: ${estimated.length}/${allTargetFiles.length} files selected`);
      for (const f of estimated) {
        console.log(`  - ${f}`);
      }
    }
  }

  let reviewFeedback = "";
  let currentTargetFiles = initialTargetFiles;
  for (let round = 1; round <= effectiveMaxRuns; round += 1) {
    console.log(`\n[forge] round ${round}/${effectiveMaxRuns}`);
    console.log(`[forge] run mode=${mode} review='${cli.reviewCmd}'`);
    let usedAgent = false;
    let agentFailed = false;
    if (mode === "assist" || mode === "agent") {
      if (!agent) {
        if (mode === "assist") {
          console.log("[forge] assist mode: agent not configured, run local-only.");
        }
      } else {
        const targetFiles = currentTargetFiles;
        const inputReference = materializeForgeInputReference(root, config, {
          request: userPrompt,
          specification: specPath ? {
            path: path.relative(root, specPath),
            content: specText,
          } : null,
          analysis: analysisSummary || null,
          previousReviewFeedback: reviewFeedback || null,
          round,
          maxRuns: effectiveMaxRuns,
        });
        const resolvedAgent = agent.resolve("docs.forge");
        const usePerFile = !!(resolvedAgent && resolvedAgent.provider.systemPromptFlag());

        if (usePerFile) {
          // Per-file async processing with system prompt separation
          const systemPrompt = buildForgeSystemPrompt({
            lang,
            inputReference,
          });

          console.log(`[forge] per-file mode: ${targetFiles.length} files, concurrency=${concurrency}`);

          const results = await runPerFile({
            agent,
            targetFiles,
            systemPrompt,
            inputReference,
            round,
            maxRuns: effectiveMaxRuns,
            concurrency,
            verbose: cli.verbose,
          });

          const succeeded = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok).length;
          console.log(`[forge] per-file done: ${succeeded} ok, ${failed} failed`);

          if (succeeded > 0) usedAgent = true;
          if (failed > 0 && succeeded === 0) agentFailed = true;
        } else {
          // Single-call mode: all files in one prompt (agent lacks systemPromptFlag)
          const prompt = buildForgePrompt({
            lang,
            round,
            maxRuns: effectiveMaxRuns,
            targetFiles,
            inputReference,
          });
          try {
            await invokeAgent(agent, prompt, {
              label: "forge.generate",
              verbose: cli.verbose,
            });
            usedAgent = true;
          } catch (e) {
            agentFailed = true;
            if (mode === "agent") {
              throw e;
            }
            console.log(
              `[forge] agent step failed. continue with local pipeline.\n${String(
                e instanceof Error ? e.message : e
              ).slice(0, 500)}`,
            );
          }
        }
      }
    }

    // docs/ を直接編集するため generate ステップは不要

    const review = await runCommand(cli.reviewCmd, root);
    console.log(`[forge] review: ${review.ok ? "ok" : "failed"} (code=${review.status})`);
    if (review.ok) {
      console.log("[forge] review passed.");
      const readme = await runCommand(`node "${path.join(PKG_DIR, "docs", "commands", "readme.js")}"`, root);
      console.log(`[forge] README.md ${readme.ok ? "updated" : "update failed"}.`);

      // Multi-language: update non-default languages after review pass
      try {
        const docsCfg = config.docs;
        if (docsCfg.languages.length >= 2) {
          const nonDefaultLangs = docsCfg.languages.filter((l) => l !== docsCfg.defaultLanguage);
          const docsMode = docsCfg.mode || "translate";
          if (docsMode === "translate") {
            console.log(`[forge] Re-translating to: ${nonDefaultLangs.join(", ")}`);
            const translateCmd = `node "${path.join(PKG_DIR, "docs", "commands", "translate.js")}" --force`;
            await runCommand(translateCmd, root);
          }
          // In generate mode, non-default langs would need separate forge runs
          // which is out of scope for this iteration
        }
      } catch (_) {
        // multi-lang not configured — skip
      }

      console.log("\n=== DONE ===\n- forge completed");
      return;
    }

    const reviewOut = `${review.stdout}\n${review.stderr}`;
    reviewFeedback = summarizeReview(reviewOut);
    console.log("[forge] review failed. feedback captured.");
    console.log(reviewFeedback);

    // Filter target files for next round: only keep files that failed review
    const fileResults = parseFileResults(reviewOut, currentTargetFiles);
    if (fileResults.passedFiles.length > 0 && fileResults.failedFiles.length > 0) {
      console.log(`[forge] ${fileResults.passedFiles.length} file(s) passed, ${fileResults.failedFiles.length} file(s) need retry`);
      currentTargetFiles = fileResults.failedFiles;
    }

    if (agentFailed) {
      console.log(
        "[forge] no local patch candidates found after agent failure."
      );
    } else if (mode === "local" && !usedAgent) {
      console.log(t("messages:forge.needsInput"));
      console.log(t("messages:forge.reviewFeedback"));
      console.log(reviewFeedback);
      process.exitCode = EXIT_ERROR;
      return;
    }
  }

  throw new Error("forge: max runs reached but review still failing.");
}

export { estimateRelevantFiles };

export default class DocsForgeCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runForge(ctx._rawArgs || [], this.container);
  }
}
