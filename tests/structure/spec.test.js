import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { checkStructure } from "../support/structure/checker.js";
import { ProductionRegistrations } from "../support/structure/production-registrations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const registrationSource = new ProductionRegistrations(
  new URL("../../src/flow/engine/composition/spec.js", import.meta.url),
  "specStepRegistrations",
);

test("Spec source obeys shared Flow structure rules through production registration", async (context) => {
  const registrations = await registrationSource.load();
  const report = checkStructure({ root, entry: "src/flow/steps/spec", registrations });
  context.diagnostic(report.describe());
  assert.equal(report.ok, true, `${report.describe()}\n${report.diagnostics.map((entry) => entry.toString()).join("\n")}`);
  assert.ok(report.visited.size > 0);
  assert.ok(report.reverseIndexed.size > 0);
});
