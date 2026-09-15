/**
 * tests/integration/flow/instructions-coverage.test.js
 *
 * Coverage check between src/flow/definition.js instructionsKey values and the
 * src/flow/prompts/<phase>/<step>.md file tree (spec 203 / cac6/T6, updated
 * for spec 236 which replaced context-rules.json with definition.js).
 *
 * Asserts:
 * - Every instructionsKey in the definition maps to an existing file at
 *   src/flow/prompts/<phase>/<step>.md.
 * - Every entry prompt file under src/flow/prompts/ is referenced by at least
 *   one instructionsKey (no orphan files).
 * - Every prompt partial under src/flow/prompts/partials/ is included by at
 *   least one entry prompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFlowNodes, collectTaskNodes } from "../../../src/flow/definition.js";

const PKG_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../src");
const PROMPTS_DIR = path.join(PKG_DIR, "flow", "prompts");
const INCLUDE_DIRECTIVE_RE = /<!--\s*include\("([^"]+)"\)\s*-->/g;

/**
 * Collect instructionsKey values from leaf nodes that require AI prompts.
 * Branch nodes (children != null) and automated steps (no outputSchemaRef)
 * are excluded — they have instructionsKey for metadata but no prompt file.
 * Typed host actions have no worker output schema, but their dispatcher-facing
 * instructions are still a registered prompt contract.
 */
function collectInstructionKeys(definition) {
  const keys = [];
  function walk(nodes) {
    for (const node of nodes) {
      if (node.children) {
        walk(node.children);
      } else if (node.instructionsKey && (node.outputSchemaRef || node.action === "filter-task-review")) {
        keys.push(node.instructionsKey);
      }
    }
  }
  walk(definition);
  return keys;
}

function collectPromptFiles(dir) {
  const files = [];
  function walk(current, relParts) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, [...relParts, entry.name]);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stepName = entry.name.replace(/\.md$/, "");
        files.push({
          key: `${relParts.join(".")}.${stepName}`,
          path: full,
          partial: relParts[0] === "partials",
        });
      }
    }
  }
  walk(dir, []);
  return files;
}

function resolveIncludePath(includePath, sourceFile) {
  if (includePath.startsWith("/")) {
    return path.join(PKG_DIR, includePath.slice(1));
  }
  return path.join(path.dirname(sourceFile), includePath);
}

function collectIncludedPromptFiles(files) {
  const included = new Set();
  for (const file of files) {
    if (file.partial) continue;
    const content = fs.readFileSync(file.path, "utf8");
    for (const match of content.matchAll(INCLUDE_DIRECTIVE_RE)) {
      const includedPath = resolveIncludePath(match[1], file.path);
      if (includedPath.startsWith(PROMPTS_DIR + path.sep)) {
        included.add(path.resolve(includedPath));
      }
    }
  }
  return included;
}

function keyToFilePath(key) {
  const parts = key.split(".");
  const stepName = parts.pop();
  return path.join(PROMPTS_DIR, ...parts, `${stepName}.md`);
}

describe("instructions-coverage (definition ↔ prompt files)", () => {
  it("every instructionsKey in the definition has a matching prompt file", () => {
    const flowKeys = collectInstructionKeys(collectFlowNodes());
    const taskKeys = collectInstructionKeys(collectTaskNodes());
    const keys = [...flowKeys, ...taskKeys];

    assert.ok(keys.length > 0, "definition has at least one instructionsKey");

    const missing = [];
    for (const key of keys) {
      const filePath = keyToFilePath(key);
      if (!fs.existsSync(filePath)) {
        missing.push({ key, expectedPath: path.relative(PKG_DIR, filePath) });
      }
    }

    assert.deepEqual(missing, [],
      `missing prompt files for keys:\n${missing.map((m) => `  ${m.key} -> ${m.expectedPath}`).join("\n")}`);
  });

  it("every entry prompt file under src/flow/prompts/ is referenced by some instructionsKey", () => {
    const flowKeys = collectInstructionKeys(collectFlowNodes());
    const taskKeys = collectInstructionKeys(collectTaskNodes());
    const registeredKeys = new Set([...flowKeys, ...taskKeys]);
    const files = collectPromptFiles(PROMPTS_DIR).filter((f) => !f.partial);

    const orphans = files.filter((f) => !registeredKeys.has(f.key));
    assert.deepEqual(orphans.map((o) => path.relative(PKG_DIR, o.path)), [],
      "orphan prompt files exist (file present but no instructionsKey references it)");
  });

  it("every prompt partial is included by at least one entry prompt", () => {
    const files = collectPromptFiles(PROMPTS_DIR);
    const partials = files.filter((f) => f.partial);
    const included = collectIncludedPromptFiles(files);

    const orphans = partials.filter((f) => !included.has(path.resolve(f.path)));
    assert.deepEqual(orphans.map((o) => path.relative(PKG_DIR, o.path)), [],
      "orphan prompt partials exist (partial present but no prompt includes it)");
  });

  it("every instructionsKey maps to an existing prompt file", () => {
    const flowKeys = collectInstructionKeys(collectFlowNodes());
    const taskKeys = collectInstructionKeys(collectTaskNodes());
    const keys = [...flowKeys, ...taskKeys];
    const files = collectPromptFiles(PROMPTS_DIR).filter((f) => !f.partial);
    const fileKeys = new Set(files.map((f) => f.key));

    const missing = keys.filter((k) => !fileKeys.has(k));
    assert.deepEqual(missing, [],
      "instructionsKeys reference non-existent prompt files");
  });
});
