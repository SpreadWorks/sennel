import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { draftStepRegistrations } from "../../src/flow/engine/composition/draft.js";
import { checkStructure } from "../support/structure/checker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Draft source obeys shared Flow structure rules", (context) => {
  const report = checkStructure({ root, entry: "src/flow/steps/draft", registrations: draftStepRegistrations });
  context.diagnostic(report.describe());
  assert.equal(report.ok, true, `${report.describe()}\n${report.diagnostics.map((entry) => entry.toString()).join("\n")}`);
  assert.ok(report.visited.size > 0);
  assert.ok(report.reverseIndexed.size > 0);
});
