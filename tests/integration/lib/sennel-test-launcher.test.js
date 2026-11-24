import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCmd } from "../../../src/lib/process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { installSennelTestLauncher } from "../../support/infrastructure/sennel-test-launcher.js";
import { testTemporaryRoot } from "../../test-environment.js";

test("fixture CLI launcher preserves module entry, literal arguments, input and exit status", (t) => {
  const root = createTmpDir("sennel-launcher-");
  t.after(() => removeTmpDir(root));
  const project = path.join(root, "module path '$!%");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  const entryPath = path.join(project, "entry.js");
  fs.writeFileSync(entryPath, `import fs from "node:fs";
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, "utf8") }));
process.stderr.write("launcher stderr");
process.exitCode = 7;
`);
  const bin = installSennelTestLauncher(project, { entryPath });
  const args = ["", "two words", "$literal", "%PATH%", "!literal"];
  let result;
  try {
    result = runCmd(path.join(bin, process.platform === "win32" ? "sennel.cmd" : "sennel"), args,
      { cwd: project, input: "literal stdin\n" });
  } catch (error) {
    testTemporaryRoot().retainOnUnconfirmedExecution(error);
    throw error;
  }
  assert.equal(result.status, 7);
  assert.equal(result.stderr, "launcher stderr");
  assert.deepEqual(JSON.parse(result.stdout), { args, input: "literal stdin\n" });
});
