import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getStepInstructions } from "../../../src/flow/lib/get-step-instructions.js";

const partialPath = new URL("../../../src/flow/prompts/partials/spec-writing.md", import.meta.url);
const sharedGuidance = fs.readFileSync(partialPath, "utf8").trimEnd();

describe("shared Spec writing prompt projection", () => {
  it("expands the same generic guidance through all three production prompt paths", () => {
    for (const key of ["plan.spec", "plan.spec-repair", "plan.spec-gate-repair"]) {
      const prompt = getStepInstructions(key);

      assert.ok(prompt.includes(sharedGuidance), `${key} includes the shared guidance verbatim`);
      assert.equal(prompt.split(sharedGuidance).length - 1, 1, `${key} includes it once`);
      assert.doesNotMatch(prompt, /<!--\s*include\("\/flow\/prompts\/partials\/spec-writing\.md"\)\s*-->/);
    }

    assert.match(sharedGuidance, /State shared conditions once/);
    assert.match(sharedGuidance, /64 KiB of canonical saved UTF-8 Spec content as authoring guidance only/);
    assert.match(sharedGuidance, /neither a hard limit nor permission to truncate/);
    assert.match(sharedGuidance, /Preserve every condition, value, identifier, literal, valid input, expected result, and rejection condition established by the authoritative inputs/);
    assert.match(sharedGuidance, /explore and read the execution checkout yourself/);
    assert.doesNotMatch(sharedGuidance, /(?:R\d+|T-\d+|--[\w-]+)/);
  });
});
