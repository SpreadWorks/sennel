#!/usr/bin/env node
/**
 * src/docs/commands/agents.js
 *
 * AGENTS.md を更新する。
 * AGENTS.md 内の {{data("agents.flow")}} / {{data("agents.project")}} ディレクティブを解決し、
 * PROJECT セクションは AI で精査する。
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "../../lib/cli.js";
import { managedOutputDir, resolveConcurrency, resolvePromptCharacterLimit } from "../../lib/config.js";
import { container } from "../../lib/container.js";
import { translate } from "../../lib/i18n.js";
import { createResolver } from "../lib/resolver-factory.js";
import { createLogger } from "../../lib/progress.js";
import { parseDirectives, replaceBlockDirective, resolveDataDirectives } from "../lib/directive-parser.js";
import { loadFullAnalysis, getChapterFiles, readText } from "../lib/command-context.js";
import { loadSpecDrivenDevelopmentTemplate } from "../../lib/agents-md.js";
import { resolveDocsContext } from "../lib/docs-context.js";
import { Command } from "../../lib/command.js";
import { synthesizeProjectInstructions } from "../lib/documentation-agents-batching.js";
import { AtomicFile } from "../../lib/atomic-file.js";

const logger = createLogger("agents");

// ---------------------------------------------------------------------------
// ディレクティブ解決
// ---------------------------------------------------------------------------

/**
 * AGENTS.md 内の {{data}} ディレクティブを解決する。
 * agents.project ディレクティブの解決結果を返す（AI 精査用）。
 */
function resolveAgentsDirectives(text, resolveFn) {
  let specDrivenDevelopmentContent = null;
  let projectContent = null;

  const result = resolveDataDirectives(
    text,
    (preset, source, method, labels, params) => resolveFn(preset, source, method, {}, labels, params),
    {
      onResolve(d, rendered) {
        if (d.source === "agents" && d.method === "flow") specDrivenDevelopmentContent = rendered;
        if (d.source === "agents" && d.method === "project") projectContent = rendered;
      },
    },
  );

  return { text: result.text, specDrivenDevelopmentContent, projectContent };
}

/**
 * AI 精査後の PROJECT セクションで、ディレクティブ内部を差し替える。
 */
function replaceProjectContent(text, refined) {
  const directives = parseDirectives(text);
  const lines = text.split("\n");

  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    if (d.type !== "data" || d.source !== "agents" || d.method !== "project") continue;
    if (d.endLine < 0) continue;

    replaceBlockDirective(lines, d, refined);
    break;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runAgents(ctx, rawArgs) {
  if (!ctx) {
    const cli = parseArgs(rawArgs, {
      flags: ["--dry-run"],
      options: [],
      defaults: { dryRun: false },
    });

    if (cli.help) {
      const tu = translate();
      const h = tu.raw("ui:help.cmdHelp.agents");
      const o = h.options;
      console.log([
        h.usage, "", `  ${h.desc}`, `  ${h.descDetail}`, "", "Options:",
        `  ${o.dryRun}`,
      ].join("\n"));
      return;
    }

    ctx = resolveDocsContext(container, cli);
    ctx.dryRun = cli.dryRun;
  }

  const { root, srcRoot, config, lang, t } = ctx;

  const agentsPath = path.join(srcRoot, "AGENTS.md");
  let newFileTemplate = null;
  if (!fs.existsSync(agentsPath)) {
    // Generate from template
    const specDrivenDevelopmentSection = loadSpecDrivenDevelopmentTemplate(lang || config?.lang || "en", {
      projectRoot: root,
      presetTypes: config?.type || "base",
    });
    const template = [
      `# ${path.basename(srcRoot)}`,
      "",
      '<!-- {{data("agents.flow")}} -->',
      specDrivenDevelopmentSection,
      "<!-- {{/data}} -->",
      "",
      '<!-- {{data("agents.project")}} -->',
      "<!-- {{/data}} -->",
      "",
    ].join("\n");
    newFileTemplate = template;
  }

  // Load analysis
  const analysis = loadFullAnalysis(root);
  if (!analysis) {
    throw new Error(t("messages:agents.analysisNotFound", { path: path.join(managedOutputDir(root), "analysis.json") }));
  }

  // Load generated docs as context (instead of raw analysis.json)
  const docsDir = path.join(root, "docs");
  const chapterFiles = getChapterFiles(docsDir, { type: ctx.type, configChapters: ctx.config?.chapters, projectRoot: root });
  const docsContent = chapterFiles.map((f) => readText(path.join(docsDir, f))).join("\n\n");
  const readmeContent = readText(path.join(srcRoot, "README.md"));
  const combinedDocs = [docsContent, readmeContent].filter(Boolean).join("\n\n---\n\n");

  // Create resolver and resolve {{data}} directives
  const resolvedType = config.type || "base";
  const resolver = await createResolver(resolvedType, root, { configChapters: config.chapters });
  const resolveFn = (preset, source, method, a, labels, params) => resolver.resolve(preset, source, method, analysis, labels, params);

  let content = newFileTemplate ?? fs.readFileSync(agentsPath, "utf8");
  const { text: resolved, specDrivenDevelopmentContent, projectContent } = resolveAgentsDirectives(content, resolveFn);
  content = resolved;

  // AI refinement for PROJECT section
  if (projectContent) {
    const agent = container.get("agent");
    if (!agent.resolve("docs.agents")) {
      throw new Error("No default agent configured. Set 'agent.default' in config.json or run 'sennel setup'.");
    }

    logger.log(t("messages:agents.refining"));
    try {
      let scripts = "";
      const pkgPath = path.join(srcRoot, "package.json");
      if (fs.existsSync(pkgPath)) {
        try { scripts = JSON.stringify(JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {}, null, 2); } catch (_) { /* skip */ }
      }
      const outputRules = t.raw("prompts:agents.outputRules") || [];
      const refined = await synthesizeProjectInstructions({
        contexts: [
          { label: "Current PROJECT section", text: projectContent },
          { label: "Existing Spec-Driven Development section; do not duplicate", text: specDrivenDevelopmentContent || "" },
          { label: "Project type", text: Array.isArray(config.type) ? config.type.join(", ") : String(config.type || "") },
          { label: "package.json scripts", text: scripts },
          { label: "Generated documentation", text: combinedDocs },
        ],
        rules: "## Output Rules (strict)\n" + outputRules.map((rule) => `- ${rule}`).join("\n"),
        agent,
        maxCharacters: resolvePromptCharacterLimit(config),
        concurrency: resolveConcurrency(config),
      });
      content = replaceProjectContent(content, refined);
    } catch (err) {
      throw new Error(`AI agent call failed: ${err.message}`);
    }

    logger.log(t("messages:agents.generated"));
  }

  if (ctx.dryRun) {
    logger.log(t("messages:agents.dryRun", { path: agentsPath }));
    console.log(content);
    return;
  }

  new AtomicFile(agentsPath).write(Buffer.from(content, "utf8"));
  if (newFileTemplate !== null) logger.log(`created ${agentsPath}`);
  console.log(t("messages:agents.updated", { path: agentsPath }));
}

export { runAgents };

export default class DocsAgentsCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runAgents(ctx.docsCtx, ctx._rawArgs || []);
  }
}
