import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("loading the audit never evaluates inspected source or its production registries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-audit-source-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  fs.cpSync(path.join(repository, "src"), path.join(root, "src"), { recursive: true });
  fs.cpSync(path.join(repository, "tests/support/structure"), path.join(root, "tests/support/structure"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const marker = path.join(root, "evaluated-source");
  fs.appendFileSync(path.join(root, "src/flow/engine/step-result.js"),
    `\nimport { writeFileSync as auditSourceSentinelWrite } from "node:fs";\nauditSourceSentinelWrite(${JSON.stringify(marker)}, "evaluated");\n`);
  const audit = await import(pathToFileURL(path.join(root, "tests/support/structure/os-audit.js")).href);
  assert.equal(typeof audit.auditOsIndependence, "function");
  assert.equal(fs.existsSync(marker), false, "source inspection must not execute Step Result registry modules");
});
