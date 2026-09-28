import { TEST_SUITES, TEST_SUITE_NAMES } from "./suite-definitions.js";

/**
 * tests/runner/test-runner-labels.js
 *
 * Helpers for the project test runner (`tests/run.js`) to emit per-type
 * label lines for the executable test suites.
 *
 * Directory → type mapping:
 *   .../tests/unit/...        → unit
 *   .../tests/integration/... → integration
 *   .../tests/e2e/...         → e2e
 *   .../tests/acceptance/...  → acceptance
 */

const CATEGORY_PATTERNS = TEST_SUITES.map(({ name, directory }) => ({
  re: new RegExp(`/tests/${directory}/`),
  type: name,
}));

export function categorizeTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  for (const { re, type } of CATEGORY_PATTERNS) {
    if (re.test(normalized)) return type;
  }
  return null;
}

export function formatLabelSummary(counts) {
  return [...TEST_SUITE_NAMES].map((name) => `${name}: ${Number(counts?.[name] ?? 0)}`).join("\n");
}

export function parsePassCount(output) {
  const match = /^\s*(?:#|ℹ)\s*pass\s+(\d+)\s*$/mu.exec(output || "");
  return match ? Number(match[1]) : 0;
}

export function groupTestFilesByCategory(files) {
  const groups = Object.fromEntries([...TEST_SUITE_NAMES, "other"].map((name) => [name, []]));
  for (const f of files) {
    const t = categorizeTestFile(f) || "other";
    groups[t].push(f);
  }
  return groups;
}
