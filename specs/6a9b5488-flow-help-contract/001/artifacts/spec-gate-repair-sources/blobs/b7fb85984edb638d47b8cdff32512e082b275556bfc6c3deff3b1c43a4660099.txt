/**
 * src/flow/lib/get-step-instructions.js
 *
 * Resolve an instructions_key (registered in src/flow/schemas/context-rules.json)
 * to the markdown content stored at src/flow/prompts/<phase>/<step>.md.
 *
 * Used by:
 *   - src/flow/lib/get-next-action.js — populates the `instructions.content`
 *     field of the next-action CLI envelope.
 *   - tests/integration/flow/get-step-instructions.test.js — contract tests.
 *
 * The loader fails loudly (throws Error with the offending key in the message)
 * for unknown keys or missing files. There is no silent empty-string fallback;
 * the coverage check (tests/integration/flow/instructions-coverage.test.js) is the
 * structural guarantee that every registered key has a backing file.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PKG_DIR } from "../../lib/cli.js";
import { resolveIncludes } from "../../lib/include.js";
import { PRODUCT } from "../../lib/product.js";

const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

function resolvePromptsDir() {
  return process.env[PRODUCT.env("NEXT_ACTION_PROMPTS_DIR")] || DEFAULT_PROMPTS_DIR;
}

/**
 * Resolve an instructions_key of the form "<phase>.<step>" to the absolute
 * path of the corresponding markdown file under the resolved prompts dir.
 */
function resolveKeyPath(instructionsKey) {
  const parts = instructionsKey.split(".");
  if (parts.length < 2) {
    throw new Error(`INSTRUCTIONS_INVALID_KEY: '${instructionsKey}' is not a <phase>.<step> key`);
  }
  const stepName = parts.pop();
  return path.join(resolvePromptsDir(), ...parts, `${stepName}.md`);
}

/**
 * Read the markdown content for a registered instructions_key.
 * Throws Error with the key in the message on any failure.
 */
export function getStepInstructions(instructionsKey) {
  if (typeof instructionsKey !== "string" || instructionsKey.length === 0) {
    throw new Error(`INSTRUCTIONS_INVALID_KEY: instructionsKey must be a non-empty string (got: ${typeof instructionsKey})`);
  }

  const filePath = resolveKeyPath(instructionsKey);
  let rawContent;
  try {
    rawContent = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`INSTRUCTIONS_NOT_FOUND: no prompt file for key '${instructionsKey}' (expected at ${filePath})`);
    }
    throw err;
  }
  try {
    return resolveIncludes(rawContent, {
      baseDir: path.dirname(filePath),
      pkgDir: PKG_DIR,
      sourceFile: filePath,
    });
  } catch (err) {
    throw new Error(
      `INSTRUCTIONS_INCLUDE_RESOLVE_FAILED: failed to resolve includes for key '${instructionsKey}' (source ${filePath}): ${err.message}`,
      { cause: err },
    );
  }
}
