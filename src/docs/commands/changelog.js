#!/usr/bin/env node
/**
 * src/docs/commands/changelog.js
 *
 * 設定された Flow spec root を走査して change_log.md を生成する。
 * 既存ファイルの MANUAL ブロックを保持する。
 */

import { docsCommands } from "../../lib/command-registry.js";
import fsp from "fs/promises";
import path from "path";
import { parseArgs, formatUTCTimestamp } from "../../lib/cli.js";
import { DEFAULT_LANG } from "../../lib/config.js";
import { translate } from "../../lib/i18n.js";
import { Command } from "../../lib/command.js";
import { ExecutionMode, WritePlan } from "../../lib/execution-plan.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { CanonicalChangelogSpec } from "../lib/canonical-changelog-spec.js";

async function optional(fsOp) {
  try {
    return await fsOp();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const statIfExists = (p) => optional(() => fsp.stat(p));
/**
 * パイプ文字をエスケープし、空白を正規化する。
 */
function sanitize(text) {
  return text
    .replace(/[\t\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

/**
 * Canonical Version Store から changelog 用メタ情報を取得する。
 *
 * title / inputLine は cataloged spec.record、status / branch は canonical
 * flow.json identity/lifecycle から得る。退役した root-level layout は読まない。
 */
function parseSpecDir(flowManager, specId) {
  const record = CanonicalChangelogSpec.read({ flowManager, specId });
  if (record === null) return null;
  const entry = record.toEntry();
  return Object.freeze({
    title: sanitize(entry.title),
    created: sanitize(entry.created),
    status: sanitize(entry.status),
    branch: sanitize(entry.branch),
    inputLine: sanitize(entry.inputLine),
    versionDirectory: entry.versionDirectory,
    links: Object.freeze(entry.links.map((link) => sanitize(link))),
  });
}

/**
 * ディレクトリ名からシリーズ情報を抽出する。
 */
function parseDirName(dirName) {
  let m = dirName.match(/^([0-9]{3})[-_](.+)$/);
  if (m) return { number: parseInt(m[1], 10), series: m[2], isBackup: false };

  m = dirName.match(/^bak\.([0-9]{3})[-_](.+)$/);
  if (m) return { number: parseInt(m[1], 10), series: m[2], isBackup: true };

  return null;
}

async function runChangelog(rawArgs, container) {
  const args = rawArgs;
  const optionArgs = args.filter((arg) => arg.startsWith("-"));
  const opts = parseArgs(optionArgs, { ...docsCommands.changelog.args, defaults: { dryRun: false } });

  if (opts.help) {
    const tu = translate();
    const h = tu.raw("ui:help.cmdHelp.changelog");
    const o = h.options;
    console.log([h.usage, "", `  ${h.desc}`, `  ${h.descDetail}`, "", "Options:", `  ${o.dryRun}`].join("\n"));
    return;
  }

  const root = container.get("root");
  const specsDir = container.get("flowSpecRoot").resolve(container.get("mainRoot"));
  const outFileArg = args.find((a) => !a.startsWith("-"));
  const outFile = outFileArg || path.join(root, "docs", "change_log.md");
  const specLinkRoot = path.relative(path.dirname(outFile), specsDir).split(path.sep).join("/") || ".";

  const cfgData = container.get("config");
  const flowManager = container.get("flowManager");
  const lang = cfgData?.docs?.defaultLanguage || cfgData?.lang || DEFAULT_LANG;
  const t = translate();

  // Collect spec entries asynchronously with bounded concurrency — satisfies
  // the "no synchronous I/O in hot paths" and "bounded resource usage"
  // guardrails (spec 207 / T8).
  const dirsRaw = await statIfExists(specsDir);
  const dirNames = dirsRaw ? (await fsp.readdir(specsDir)).sort() : [];
  const concurrencyLimit = Math.max(1, cfgData?.concurrency || 4);
  const results = await mapWithConcurrency(dirNames, concurrencyLimit, async (dirName) => {
    const parsed = parseDirName(dirName);
    if (!parsed) return null;
    const meta = parseSpecDir(flowManager, dirName);
    if (meta === null) return null;

    return {
      dirName,
      series: parsed.series,
      number: parsed.number,
      isBackup: parsed.isBackup,
      ...meta,
    };
  });
  const entries = [];
  for (const r of results) {
    if (r.error) throw r.error;
    if (r.value) entries.push(r.value);
  }

  // Find latest non-backup per series
  const latestBySeries = {};
  for (const entry of entries) {
    if (entry.isBackup) continue;
    const key = entry.series;
    if (!latestBySeries[key] || entry.number > latestBySeries[key].number) {
      latestBySeries[key] = entry;
    }
  }
  const latestEntries = Object.values(latestBySeries).sort((a, b) =>
    a.series.localeCompare(b.series)
  );

  // Generate output
  const now = formatUTCTimestamp();
  const out = [];

  out.push("<!-- AUTO-GEN:START -->");
  out.push(t("messages:changelog.heading"));
  out.push("");
  out.push(t("messages:changelog.sectionDescription"));
  out.push("");
  out.push(t("messages:changelog.descriptionBody"));
  out.push("");
  out.push(t("messages:changelog.sectionContents"));
  out.push("");
  out.push(t("messages:changelog.sectionTimestamp"));
  out.push("");
  out.push(`- generated_at: ${now}`);
  out.push("");
  out.push(t("messages:changelog.sectionLatestIndex"));
  out.push("");
  out.push("| series | latest | status | created | spec |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const e of latestEntries) {
    out.push(`| \`${e.series}\` | \`${e.dirName}\` | ${e.status} | ${e.created} | [spec](${specLinkRoot}/${e.versionDirectory}/spec.json) |`);
  }
  out.push("");
  out.push(t("messages:changelog.sectionAllSpecs"));
  out.push("");
  out.push("| dir | status | created | title | summary | files |");
  out.push("| --- | --- | --- | --- | --- | --- |");

  const sortedEntries = [...entries].sort((a, b) => a.dirName.localeCompare(b.dirName));
  for (const e of sortedEntries) {
    let fileLinks;
    if (e.links.length > 1) {
      fileLinks = e.links.map((f) => `[${f}](${specLinkRoot}/${e.versionDirectory}/${f})`).join(", ");
    } else {
      const f = e.links[0] || "spec.json";
      fileLinks = `[${f}](${specLinkRoot}/${e.versionDirectory}/${f})`;
    }
    out.push(`| \`${e.dirName}\` | ${e.status} | ${e.created} | ${e.title} | ${e.inputLine} | ${fileLinks} |`);
  }

  out.push("<!-- AUTO-GEN:END -->");
  out.push("");

  const content = out.join("\n");
  const plan = new WritePlan(`generate changelog at ${outFile}`, { preview: content });
  plan.add(`create ${path.dirname(outFile)} and write ${outFile}`, async () => {
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(outFile, content);
    console.log(t("messages:changelog.generated", { path: outFile }));
  });

  const mode = ExecutionMode.fromDryRun(opts.dryRun);
  return mode.execute(plan, {
    write(rendered) {
      console.log(rendered);
      console.error(t("messages:changelog.dryRun", { path: outFile }));
    },
  });
}

export default class DocsChangelogCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runChangelog(ctx._rawArgs || [], this.container);
  }
}
