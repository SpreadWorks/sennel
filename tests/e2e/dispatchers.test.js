import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTmpDir, removeTmpDir, writeJson } from "../support/builders/tmp-dir.js";

const SENNEL = join(process.cwd(), "src/sennel.js");

function createHookConfigProject(command) {
  const root = createTmpDir("sennel-hook-list-e2e-");
  writeJson(root, ".sennel/config.json", {
    lang: "en",
    type: "sample-node-command",
    docs: { languages: ["en"], defaultLanguage: "en" },
    flow: {
      hooks: {
        PostWorktree: command,
      },
    },
  });
  return root;
}

function expectDispatcherFailure(args, assertions, message = "should exit non-zero", options = {}) {
  let failure;
  try {
    execFileSync(process.execPath, [SENNEL, ...args], { encoding: "utf8", ...options });
  } catch (err) {
    failure = err;
  }
  if (!failure) assert.fail(message);
  assertions(failure);
}

function expectUnknownCommand(args, message) {
  expectDispatcherFailure(args, (err) => {
    assert.match(err.stderr, /unknown command/);
  }, message);
}

describe("sennel dispatcher", () => {
  it("routes 'help' to help output", () => {
    const result = execFileSync("node", [SENNEL, "help"], { encoding: "utf8" });
    assert.match(result, /sennel/);
    assert.match(result, /Commands|コマンド一覧/);
  });

  it("routes 'docs build' through docs dispatcher", () => {
    // build requires analysis.json etc, but should at least start the pipeline
    try {
      execFileSync("node", [SENNEL, "docs", "build", "--help"], { encoding: "utf8" });
    } catch (err) {
      // --help may exit 0 or non-zero depending on implementation
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /build/i);
    }
  });

  it("rejects unknown spec subcommand", () => {
    expectUnknownCommand(["spec", "gate"]);
  });

  it("routes 'docs review' correctly", () => {
    try {
      execFileSync("node", [SENNEL, "docs", "review"], { encoding: "utf8" });
    } catch (err) {
      // review may fail if no docs dir, but it should have run the review command
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /FAIL|Found|章ファイル/);
    }
  });

  it("routes 'setup --help' as independent command", () => {
    const result = execFileSync("node", [SENNEL, "setup", "--help"], { encoding: "utf8" });
    assert.match(result, /setup/i);
  });

  it("prints Flow help and fails with that help when no command is supplied", (t) => {
    const root = createTmpDir("flow-routing-e2e-");
    t.after(() => removeTmpDir(root));
    const help = execFileSync(process.execPath, [SENNEL, "flow", "--help"], { cwd: root, encoding: "utf8" });
    for (const group of ["get", "set", "run"]) assert.match(help, new RegExp(`\\b${group}\\b`));
    expectDispatcherFailure(["flow"], (failure) => {
      assert.equal(failure.status, 1);
      assert.equal(failure.signal, null);
      assert.equal(failure.stdout, help);
    }, "missing Flow command must fail", { cwd: root });
  });

  for (const command of [["unregistered-flow-group"], ["get", "unregistered-flow-command"]]) {
    it(`rejects unknown Flow route ${command.join(" ")} with a typed failure envelope`, (t) => {
      const root = createTmpDir("flow-routing-refusal-e2e-");
      t.after(() => removeTmpDir(root));
      expectDispatcherFailure(["flow", ...command], (failure) => {
        assert.equal(failure.status, 1);
        assert.equal(failure.signal, null);
        const envelope = JSON.parse(failure.stdout);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.type, command.length === 1 ? "run" : command[0]);
        assert.equal(envelope.key, "unknown");
        assert.deepEqual(envelope.errors.map((error) => error.code), ["FLOW_UNKNOWN_COMMAND"]);
        assert.equal(envelope.guidance.schemaVersion, 1);
        assert.equal(envelope.guidance.code, "FLOW_UNKNOWN_COMMAND");
        assert.equal(envelope.guidance.nextAction.kind, "external_work");
        assert.equal(envelope.guidance.currentState.persistence, "unconfirmed");
        assert.ok(envelope.guidance.explanation.length > 0);
        assert.ok(envelope.guidance.nextAction.instruction.length > 0);
      }, "unknown Flow route must fail", { cwd: root });
    });
  }

  it("exposes registered-active-flow resume help without parked recovery", () => {
    const resume = execFileSync("node", [SENNEL, "flow", "resume", "--help"], { encoding: "utf8" });
    assert.match(resume, /registered active flow/i);
    assert.match(resume, /--spec/);
    assert.match(resume, /--expect-run-id/);
    assert.doesNotMatch(resume, /parked|park/i);
  });

  it("shows docs subcommand list when 'docs' has no args", () => {
    try {
      execFileSync("node", [SENNEL, "docs"], { encoding: "utf8" });
    } catch (err) {
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /build|scan|forge/);
    }
  });

  it("shows spec subcommand usage when 'spec' has no args", () => {
    try {
      execFileSync("node", [SENNEL, "spec"], { encoding: "utf8" });
      assert.fail("should exit non-zero without subcommand");
    } catch (err) {
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, /Usage: sennel spec/);
      assert.match(out, /render/);
    }
  });

  it("routes 'hook list' through hook dispatcher", () => {
    const result = execFileSync("node", [SENNEL, "hook", "list"], { encoding: "utf8" });
    assert.match(result, /PostWorktree/);
    assert.match(result, /worktree/i);
  });

  it("routes 'hook list --json' and includes the current configured command", () => {
    const tmp = createHookConfigProject("printf hook-json");
    try {
      const result = execFileSync("node", [SENNEL, "hook", "list", "--json"], {
        encoding: "utf8",
        env: { ...process.env, SENNEL_WORK_ROOT: tmp },
      });
      const hooks = JSON.parse(result);
      const postWorktree = hooks.find((hook) => hook.name === "PostWorktree");
      assert.ok(postWorktree);
      assert.equal(postWorktree.command, "printf hook-json");
      assert.deepEqual(postWorktree.placeholders, ["CWD"]);
    } finally {
      removeTmpDir(tmp);
    }
  });

  it("rejects unknown hook list options", () => {
    expectDispatcherFailure(["hook", "list", "--unknown"], (err) => {
      assert.match(err.stderr, /Unknown option/);
    });
  });

  it("shows help when no subcommand", () => {
    const result = execFileSync("node", [SENNEL], { encoding: "utf8" });
    assert.match(result, /sennel/);
  });

  it("exits non-zero for unknown subcommand", () => {
    expectUnknownCommand(["nonexistent"]);
  });

  it("suggests the canonical status command for mistyped flow status", () => {
    expectDispatcherFailure(["flow", "status"], (err) => {
      assert.match(err.stderr, /unknown command 'status'/);
      assert.match(err.stderr, /Did you mean: sennel flow get status/);
    });
  });

  it("rejects old flat commands (build, gate)", () => {
    for (const cmd of ["build", "gate", "scan", "review"]) {
      expectUnknownCommand([cmd], `'${cmd}' should exit non-zero`);
    }
  });
});
