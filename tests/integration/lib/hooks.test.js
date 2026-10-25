import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, removeTmpDir, writeJson } from "../../support/builders/tmp-dir.js";
import { onHook } from "../../../src/lib/hooks.js";

function baseConfig(command) {
  return {
    lang: "en",
    type: "sample-node-command",
    docs: { languages: ["en"], defaultLanguage: "en" },
    flow: command == null ? {} : {
      hooks: {
        PostWorktree: command,
      },
    },
  };
}

function writeConfig(root, command) {
  writeJson(root, ".sennel/config.json", baseConfig(command));
}

async function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await fn();
    return { result, warnings: warnings.join("\n") };
  } finally {
    console.warn = originalWarn;
  }
}

describe("flow hooks", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("returns a no-op envelope when PostWorktree is not configured", async () => {
    tmp = createTmpDir("sennel-hooks-unit-noop-");
    writeConfig(tmp);

    const result = await onHook("PostWorktree", { CWD: tmp });

    assert.deepEqual(result, { ok: true, output: "", stderr: "", status: 0 });
  });

  it("executes configured hook commands with literal placeholders and cwd", async () => {
    tmp = createTmpDir("sennel-hooks-unit-exec-");
    writeConfig(tmp, { kind: "native", executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify([process.cwd(), ...process.argv.slice(1)]))", "{{CWD}}", "$HOME&literal"] });
    const result = await onHook("PostWorktree", { CWD: tmp });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.output), [tmp, tmp, "$HOME&literal"]);
  });

  it("leaves missing placeholders unchanged and warns", async () => {
    tmp = createTmpDir("sennel-hooks-unit-missing-");
    writeConfig(tmp, { kind: "native", executable: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "{{MISSING}}"] });

    const { result, warnings } = await captureWarnings(() => onHook("PostWorktree", { CWD: tmp }));

    assert.equal(result.ok, true);
    assert.equal(result.output, "{{MISSING}}");
    assert.match(warnings, /MISSING/);
  });

  it("returns ok:false without throwing when the command fails", async () => {
    tmp = createTmpDir("sennel-hooks-unit-failure-");
    writeConfig(tmp, { kind: "native", executable: process.execPath, args: ["-e", "process.stderr.write('hook failed'); process.exit(7)"] });

    const { result, warnings } = await captureWarnings(() => onHook("PostWorktree", { CWD: tmp }));

    assert.equal(result.ok, false);
    assert.equal(result.status, 7);
    assert.match(result.stderr, /hook failed/);
    assert.match(warnings, /PostWorktree/);
  });
});
