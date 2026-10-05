/**
 * src/lib/lint.js
 *
 * Guardrail lint logic: mechanical check of files against lint patterns.
 * Extracted from spec/commands/lint.js for use by flow commands.
 */

import fs from "fs";
import path from "path";
import { assertOk } from "./process.js";
import { runGit } from "./git-helpers.js";
import { filterByPhase, matchScope } from "./guardrail.js";

/**
 * Validate guardrails for lint misconfiguration.
 * Warns when a guardrail has a lint pattern but phase does not include "lint".
 *
 * @param {Object[]} guardrails
 * @returns {string[]} Warning messages
 */
export function validateLintGuardrails(guardrails) {
  const warnings = [];
  for (const g of guardrails) {
    if (Array.isArray(g.meta?.phase) && g.meta.phase.length === 0) continue;
    if (g.meta?.lint && !g.meta.phase?.includes("lint")) {
      warnings.push(`WARN: "${g.title}" has lint pattern but phase does not include "lint"`);
    }
  }
  return warnings;
}

/**
 * Get changed files between base branch and HEAD.
 *
 * @param {string} root - Repository root
 * @param {string} base - Base branch name
 * @returns {string[]} Relative file paths
 */
export function getChangedFiles(root, base) {
  const res = runGit(["-C", root, "diff", "--name-only", `${base}...HEAD`]);
  if (!res.ok) {
    assertOk(res, "git diff failed");
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Run lint patterns against file contents.
 *
 * @param {string} root - Repository root
 * @param {Object[]} guardrails - Lint guardrails
 * @param {string[]} files - Changed file paths (relative)
 * @returns {{ guardrail: string, file: string, line: number, match: string }[]} Failures
 */
export function runLintChecks(root, guardrails, files) {
  const failures = [];

  for (const g of guardrails) {
    const pattern = g.meta.lint;
    if (!pattern) continue;

    const targetFiles = files.filter((f) => matchScope(f, g.meta.scope));

    for (const file of targetFiles) {
      const absPath = path.join(root, file);
      if (!fs.existsSync(absPath)) continue;

      const content = fs.readFileSync(absPath, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) {
          failures.push({
            guardrail: g.title,
            file,
            line: i + 1,
            match: lines[i].trim().slice(0, 80),
          });
        }
      }
    }
  }

  return failures;
}

/**
 * Run the full lint pipeline.
 *
 * @param {string} root - Repository root
 * @param {Object[]} allGuardrails - All guardrails
 * @param {string} base - Base branch for git diff
 * @returns {{ ok: boolean, warnings: string[], lintGuardrailCount: number, fileCount: number, failures: Object[] }}
 */
export function runLint(root, allGuardrails, base) {
  const warnings = validateLintGuardrails(allGuardrails);

  // Filter to lint-phase guardrails with lint patterns
  const lintGuardrails = filterByPhase(allGuardrails, "lint").filter((g) => g.meta.lint);

  if (lintGuardrails.length === 0) {
    return { ok: true, warnings, lintGuardrailCount: 0, fileCount: 0, failures: [] };
  }

  // Get changed files
  const changedFiles = getChangedFiles(root, base);
  if (changedFiles.length === 0) {
    return { ok: true, warnings, lintGuardrailCount: lintGuardrails.length, fileCount: 0, failures: [] };
  }

  // Run checks
  const failures = runLintChecks(root, lintGuardrails, changedFiles);

  return {
    ok: failures.length === 0,
    warnings,
    lintGuardrailCount: lintGuardrails.length,
    fileCount: changedFiles.length,
    failures,
  };
}
