import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-values.js";

test("literal known-origin matching preserves independent occurrences while longer origins own overlapping matches", () => {
  const origins = ["src/file.js", "vendor/src/file.js", 'quoted/file"name.js', "src/file.js.map"];
  const references = (value) => [...SpecGateRepairSource.referencedOrigins(value, origins)].sort();
  assert.deepEqual(references({ request: '対象vendor/src/file.jsを確認し、quoted/file"name.jsを保持する',
    fields: ["src/file.js.mapを変更する"] }), ['quoted/file"name.js', "src/file.js.map", "vendor/src/file.js"]);
  assert.deepEqual(references({ request: "対象vendor/src/file.jsを確認する。その後src/file.jsを変更する。",
    fields: ["src/file.js.mapを保持する"] }), ["src/file.js", "src/file.js.map", "vendor/src/file.js"]);
  assert.deepEqual(references({ request: "No registered source reference." }), []);
});
