import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_IDENTITIES = [
  {
    lower: "sdd" + "-" + "forge",
    variants: ["sdd" + "." + "forge", "sdd" + "_" + "forge", "sdd" + "forge", "SDD" + " " + "Forge"],
    camel: "sdd" + "Forge",
    pascal: "Sdd" + "Forge",
    constant: "SDD" + "_FORGE",
  },
  { lower: "sen" + "ti", variants: [], camel: "sen" + "ti", pascal: "Sen" + "ti", constant: "SEN" + "TI" },
  { lower: "sen" + "rail", variants: [], camel: "sen" + "rail", pascal: "Sen" + "rail", constant: "SEN" + "RAIL" },
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OLD_PRODUCT_PATTERN = new RegExp(LEGACY_IDENTITIES.map(({ lower, variants, camel, pascal, constant }) => (
  `(?<![A-Za-z0-9_])(?:${[lower, ...variants, camel, pascal].map(escapeRegex).join("|")})(?=$|[^a-z0-9_]|[A-Z])|(?<![A-Za-z0-9_])${escapeRegex(constant)}(?=$|[^A-Z])`
)).join("|"));
const SCANNED_PATHS = [
  "src",
  "tests",
  "docs",
  ".codex",
  ".github",
  ".agents",
  ".claude",
  "README.md",
  "package.json",
  ".gitignore",
  ".gitattributes",
  ".sennel/templates",
  ".sennel/presets",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
];
const ALLOWLIST = new Map([
  ["tests/unit/rename-scan.test.js", "the detector must name the retired identities it tests"],
  ["CHANGELOG.md", "historical release record"],
  ["docs/change_log.md", "historical generated change log"],
  ["src/lib/layout-migration.js", "explicit one-way legacy migration input and old-journal recovery"],
  ["src/lib/legacy-managed-directory-migration.js", "explicit one-way legacy managed-root migration boundary"],
  ["src/lib/legacy-managed-metadata-migration.js", "explicit one-way legacy metadata migration boundary"],
  ["tests/integration/specs-migration.test.js", "migration-only legacy managed-root fixture"],
  ["src/lib/gitignore.js", "migration-only managed root metadata lines"],
  ["src/lib/gitattributes.js", "migration-only managed root metadata lines"],
  ["src/lib/agent-config-files.js", "normal upgrade replaces legacy managed instruction blocks"],
  ["src/lib/skills.js", "normal upgrade removes retired product skill namespaces"],
  ["src/locale/en/ui.json", "explicit migration CLI input help"],
  ["src/locale/ja/ui.json", "explicit migration CLI input help"],
  ["tests/integration/upgrade-agent-files.test.js", "legacy managed instruction-block fixture"],
  ["tests/integration/layout-migration.test.js", "legacy migration input fixtures"],
  ["tests/fixtures/process-owner-v7/layout-journal.json", "immutable baseline-produced legacy journal for explicit owner-format refusal"],
  ["tests/integration/process-owner-contract.test.js", "migration-only legacy managed-root and owner-format fixture"],
  ["tests/integration/lib/gitignore.test.js", "normalizer boundary fixture for retired managed metadata"],
  ["tests/integration/lib/gitattributes.test.js", "normalizer boundary fixture for retired managed metadata"],
  ["tests/integration/lib/cleanup-obsolete-skills.test.js", "retired product skill cleanup fixture"],
]);
function filesUnder(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  if (fs.statSync(absolutePath).isFile()) return [absolutePath];
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    files.push(...filesUnder(path.join(relativePath, entry.name)));
  }
  return files;
}

function isTextSource(file) {
  return /\.(?:js|json|md|ya?ml)$/.test(file) || ["README.md", "package.json", ".gitignore", ".gitattributes", "AGENTS.md", "CLAUDE.md"].includes(path.basename(file));
}

function findOldProductHits() {
  const hits = [];
  for (const scanPath of SCANNED_PATHS) {
    for (const file of filesUnder(scanPath)) {
      const relativePath = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWLIST.has(relativePath)) continue;
      if (OLD_PRODUCT_PATTERN.test(relativePath)) hits.push(`${relativePath} (path)`);
      if (!isTextSource(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (OLD_PRODUCT_PATTERN.test(content)) hits.push(`${relativePath} (content)`);
    }
  }
  return hits;
}

function containsOldProductName(value) {
  return OLD_PRODUCT_PATTERN.test(value);
}

describe("rename scan", () => {
  it("detects retired SDD Forge, Senti, and Senrail dots, hyphens, underscores, camel/Pascal names, runtime paths, URLs, env vars, and skills", () => {
    for (const { lower, variants, camel, pascal, constant } of LEGACY_IDENTITIES) {
      for (const value of [
        lower, ...variants, `.${lower}/config.json`, `${lower}/flow`, `${lower}.flow`,
        `https://github.com/SpreadWorks/${lower}.git`, `${constant}_WORK_ROOT`,
        `${camel}Phase`, `${pascal}MigrationEvidence`,
      ]) assert.equal(containsOldProductName(value), true, value);
      for (const value of [`x${lower}`, `${lower}nel`, `${constant}NEL`, `x${camel}`]) {
        assert.equal(containsOldProductName(value), false, value);
      }
    }
  });

  it("covers source, generated docs, metadata, and file paths with a precise legacy allowlist", () => {
    assert.deepEqual(findOldProductHits(), []);
  });
});
