#!/usr/bin/env node
/**
 * src/spec/commands/render.js
 *
 * sennel spec render — render a spec.json into spec.md.
 *
 * spec.json is the primary spec data; spec.md is a generated human-readable
 * view rendered when an operator needs to inspect or approve the spec.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../lib/cli.js";
import { Command } from "../../lib/command.js";
import { EXIT_ERROR } from "../../lib/constants.js";
import { validateSchema } from "../../lib/schema-validate.js";
import {
  SpecRenderContext,
  SpecRenderOutputLocation,
  TaskCollection,
  TaskRenderPlan,
} from "../lib/render-contract.js";

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "flow", "schemas", "spec.schema.json",
);

function printHelp() {
  console.log(
    [
      "Usage: sennel spec render [options]",
      "",
      "Render spec.json into spec.md (derivative).",
      "",
      "Options:",
      "  --spec <path>    Directory containing spec.json (default: active flow spec dir)",
      "  --out <path>     Output spec.md path (default: <spec dir>/.runtime/spec-render/spec.md)",
      "  -h, --help       Show this help",
    ].join("\n"),
  );
}

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

/**
 * Validate a CLI path option at the entry point. Rejects non-string types,
 * empty strings, and embedded NUL bytes. Returns the trimmed value (or undefined
 * if the option was not provided).
 */
function validatePathOption(raw, name) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    process.stderr.write(`sennel spec render: ${name} must be a string\n`);
    process.exit(EXIT_ERROR);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    process.stderr.write(`sennel spec render: ${name} requires a non-empty path\n`);
    process.exit(EXIT_ERROR);
  }
  if (trimmed.includes("\0")) {
    process.stderr.write(`sennel spec render: ${name} contains invalid NUL byte\n`);
    process.exit(EXIT_ERROR);
  }
  return trimmed;
}

/**
 * Render a list-shaped section. Uses `format` to serialize each entry, joins
 * with newlines, and falls back to `empty` when the list is missing or empty.
 */
function renderList(items, format, empty = "-") {
  if (!items || items.length === 0) return empty;
  return items.map(format).join("\n");
}

const bullet = (line) => `- ${line}`;
const openCheckbox = (line) => `- [ ] ${line}`;
const formatRequirement = (req) => {
  const pri = req.priority ? ` [${req.priority}]` : "";
  return `- ${req.id}${pri}: ${req.desc}`;
};
const formatClarification = (entry) => `- Q: ${entry.q}\n  - A: ${entry.a}`;
const formatAlternative = (entry) => `- ${entry.option} — ${entry.reason}`;

const overviewEntry = (entry) => `- ${entry.text}`;

function renderOverviewSub(label, items) {
  return `### ${label}\n${renderList(items, overviewEntry)}`;
}

/**
 * Render the User Confirmation section from spec.user_approval. When the field
 * is absent or `approved` is false, emit the unapproved placeholder (preserves
 * the gate's section-presence check). When `approved` is true, emit a checked
 * marker plus the persisted confirmed_at and notes.
 */
function renderUserConfirmation(userApproval) {
  const approved = userApproval?.approved === true;
  const checkbox = approved ? "- [x] User approved this spec" : "- [ ] User approved this spec";
  const confirmedAt = approved ? (userApproval?.confirmed_at ?? "") : "";
  const notes = approved ? (userApproval?.notes ?? "") : "";
  return [
    checkbox,
    confirmedAt ? `- Confirmed at: ${confirmedAt}` : "- Confirmed at:",
    notes ? `- Notes: ${notes}` : "- Notes:",
  ];
}

/**
 * Pure render function. Given a validated spec object and meta info, produce
 * the Markdown text for spec.md. Deterministic — no timestamps or randomness.
 *
 * @param {object} spec - Parsed spec.json content (schema-validated)
 * @param {object} meta - { title, featureBranch, created, status, input }
 * @returns {string} spec.md content
 */
export function renderSpecMarkdown(spec, meta) {
  const sections = [];

  sections.push(`# Feature Specification: ${meta.title}`);
  sections.push("");
  sections.push(`**Feature Branch**: \`${meta.featureBranch}\``);
  sections.push(`**Created**: ${meta.created}`);
  sections.push(`**Status**: ${meta.status || "Draft"}`);
  sections.push(`**Input**: ${meta.input || "User request"}`);
  sections.push("");

  sections.push("## Goal");
  sections.push(spec.goal || "-");
  sections.push("");

  sections.push("## Background");
  sections.push(spec.background || "-");
  sections.push("");

  sections.push("## Scope");
  sections.push(renderList(spec.scope?.in, bullet));
  sections.push("");

  sections.push("## Out of Scope");
  sections.push(renderList(spec.scope?.out, bullet));
  sections.push("");

  sections.push("## Constraints");
  sections.push(renderList(spec.constraints, bullet));
  sections.push("");

  sections.push("## Design Principles");
  sections.push(renderList(spec.design_principles, bullet));
  sections.push("");

  sections.push("## Overview");
  sections.push(renderOverviewSub("Modules", spec.overview?.modules));
  sections.push("");
  sections.push(renderOverviewSub("Data Flow", spec.overview?.data_flow));
  sections.push("");
  sections.push(renderOverviewSub("Decisions", spec.overview?.decisions));
  sections.push("");

  sections.push("## Clarifications (Q&A)");
  sections.push(renderList(spec.clarifications, formatClarification, "- Q:\n  - A:"));
  sections.push("");

  sections.push("## Alternatives Considered");
  sections.push(renderList(spec.alternatives_considered, formatAlternative));
  sections.push("");

  sections.push("## User Confirmation");
  for (const line of renderUserConfirmation(spec.user_approval)) {
    sections.push(line);
  }
  sections.push("");

  sections.push("## Requirements");
  sections.push(renderList(spec.requirements, formatRequirement));
  sections.push("");

  sections.push("## Acceptance Criteria");
  sections.push(renderList(spec.acceptance_criteria, bullet));
  sections.push("");

  sections.push("## Implementation Targets");
  sections.push(renderList(spec.implementationTargets, bullet));
  sections.push("");

  if (Array.isArray(spec.authorized_test_modifications) && spec.authorized_test_modifications.length > 0) {
    sections.push("## Authorized Existing Test Modifications");
    for (const entry of spec.authorized_test_modifications) {
      sections.push(`- **${entry.path}** — ${entry.reason}`);
    }
    sections.push("");
  }

  sections.push("## Open Questions");
  sections.push(renderList(spec.open_questions, openCheckbox, "- [ ]"));
  sections.push("");

  if (Array.isArray(spec.tasks) && spec.tasks.length > 0) {
    sections.push("## Tasks");
    const byRound = new Map();
    for (const t of spec.tasks) {
      const r = t.added_round ?? 0;
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r).push(t);
    }
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    for (const r of rounds) {
      sections.push(`### Round ${r}`);
      for (const t of byRound.get(r)) {
        sections.push(`- **${t.id}** [${t.status}]: ${t.title}`);
        if (t.goal) sections.push(`  - ${t.goal}`);
        sections.push(`  - see \`tasks/${t.id}.md\` for full spec`);
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}

/**
 * Render a single task's markdown spec (tasks/<id>.md).
 *
 * Spec 226: Auto-generated from spec.json.tasks[*]. Manual edits are forbidden
 * (like spec.md). Re-running `sennel spec render` overwrites.
 *
 * @param {object} task - one entry from spec.json.tasks[]
 * @returns {string}
 */
export function renderTaskMarkdown(task) {
  const lines = [];
  lines.push(`# ${task.id}: ${task.title}`);
  lines.push("");
  lines.push("<!-- Auto-generated by `sennel spec render` from spec.json.tasks[]. Do not edit manually. -->");
  lines.push("");
  lines.push("## Goal");
  lines.push(task.goal || "");
  lines.push("");
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) {
    lines.push("## Acceptance Criteria");
    for (const a of task.acceptance) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }
  if (task.implementation_notes) {
    lines.push("## Implementation Notes");
    lines.push(task.implementation_notes);
    lines.push("");
  }
  if (task.test_strategy) {
    lines.push("## Test Strategy");
    lines.push(task.test_strategy);
    lines.push("");
  }
  lines.push("---");
  const parentLabel = task.parent == null ? "(root)" : task.parent;
  lines.push(`Status: ${task.status} | Parent: ${parentLabel} | Added Round: ${task.added_round}`);
  lines.push("");
  return lines.join("\n");
}

function resolveActiveSpecDir(container) {
  const flowManager = container.get("flowManager");
  const state = flowManager.load();
  if (!state?.specId) {
    throw new Error("no active Flow is available for spec rendering");
  }
  // The active Flow is already resolved by FlowManager.  Reuse its Version
  // location rather than reconstructing the retired `<specRoot>/<specId>`
  // directory from an otherwise compatible command view.
  return Object.freeze({ state, directory: flowManager.specLocation(state.specId).directory });
}

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalSpecView(flowManager, state) {
  if (state === null) return null;
  const artifact = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "spec.record",
    consumerNodeId: "system",
  });
  try {
    return JSON.parse(artifact.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`canonical spec.json is invalid: ${error.message}`);
  }
}

async function runSpecRender(rawArgs, container) {
  const cli = parseArgs(rawArgs, {
    flags: [],
    options: ["--spec", "--out"],
  });

  if (cli.help || cli.h) {
    printHelp();
    return;
  }

  const root = container.get("root");
  const specDirArg = validatePathOption(cli.spec, "--spec");
  const outArg = validatePathOption(cli.out, "--out");

  const active = specDirArg ? null : resolveActiveSpecDir(container);
  const specDir = specDirArg
    ? (path.isAbsolute(specDirArg) ? specDirArg : path.join(root, specDirArg))
    : active.directory;

  if (!fs.existsSync(specDir) || !fs.statSync(specDir).isDirectory()) {
    process.stderr.write(`sennel spec render: spec directory not found: ${specDir}\n`);
    process.exit(EXIT_ERROR);
  }

  const specJsonPath = path.join(specDir, "spec.json");
  if (!fs.existsSync(specJsonPath)) {
    process.stderr.write(`sennel spec render: spec.json not found at ${specJsonPath}\n`);
    process.exit(EXIT_ERROR);
  }

  const spec = active === null
    ? JSON.parse(fs.readFileSync(specJsonPath, "utf8"))
    : canonicalSpecView(container.get("flowManager"), active.state);
  const schema = loadSchema();
  const errors = validateSchema(spec, schema);
  if (errors.length > 0) {
    process.stderr.write(`sennel spec render: spec.json failed schema validation:\n`);
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    process.exit(EXIT_ERROR);
  }

  const outPath = outArg
    ? (path.isAbsolute(outArg) ? outArg : path.join(root, outArg))
    : null;
  const outputs = new SpecRenderOutputLocation({ specDir, specMarkdownFile: outPath });
  if (outPath !== null && isInside(specDir, outputs.specMarkdownFile) && !isInside(outputs.runtimeDirectory, outputs.specMarkdownFile)) {
    process.stderr.write(
      "sennel spec render: persistent Markdown inside a canonical spec directory is retired; omit --out or use .runtime/\n",
    );
    process.exit(EXIT_ERROR);
  }
  const collection = new TaskCollection(spec.tasks ?? []);
  const renderContext = new SpecRenderContext({
    root,
    specDir,
    specJsonPath,
    flowState: active?.state ?? null,
  });
  const tasksDir = outputs.tasksDirectory;
  const taskPlan = new TaskRenderPlan({
    collection,
    tasksDir,
    renderTask: renderTaskMarkdown,
  });
  const output = renderSpecMarkdown(spec, renderContext.toRenderMeta());

  fs.mkdirSync(path.dirname(outputs.specMarkdownFile), { recursive: true });
  fs.writeFileSync(outputs.specMarkdownFile, output);
  process.stdout.write(`rendered: ${path.relative(root, outputs.specMarkdownFile)}\n`);

  // Spec 226: render tasks/<id>.md for each task entry. Additive only —
  // orphan files in tasks/ are NOT deleted (append-only principle per spec 215).
  // Uses async writes + Promise.all to avoid per-iteration synchronous I/O.
  if (taskPlan.size > 0) {
    fs.mkdirSync(tasksDir, { recursive: true });
    const writes = [...taskPlan].map(async (entry) => {
      await fs.promises.writeFile(entry.outputPath.value, entry.markdown);
      process.stdout.write(`rendered: ${path.relative(root, entry.outputPath.value)}\n`);
    });
    await Promise.all(writes);
  }
}

export default class SpecRenderCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runSpecRender(ctx._rawArgs || [], ctx.container);
  }
}

export { runSpecRender };
