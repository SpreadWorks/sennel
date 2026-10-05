import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { execFileSync } from "child_process";
import { buildCoreHelpModel, commands } from "../../src/help.js";
import { allCommands } from "../../src/lib/command-registry.js";

const CMD = join(process.cwd(), "src/sennel.js");
const CMD_ARGS_PREFIX = ["help"];

describe("help", () => {
  it("exports command metadata registry", () => {
    assert.equal(Array.isArray(commands), false);
    assert.equal(typeof commands.findCommand, "function");
  });

  it("has expected commands in namespace groups", () => {
    const names = buildCoreHelpModel({ commands: allCommands, lang: "en" }).allCommands().map((c) => c.name);
    assert.ok(names.includes("help"));
    assert.ok(names.includes("setup"));
    assert.ok(names.includes("docs build"));
    assert.ok(names.includes("flow get"));
    assert.ok(names.includes("flow set"));
    assert.ok(names.includes("flow run"));
  });

  it("does not include old flat commands", () => {
    const names = buildCoreHelpModel({ commands: allCommands, lang: "en" }).topLevelCommands().map((c) => c.fullName || c.name);
    assert.ok(!names.includes("build"), "should not have flat 'build'");
    assert.ok(!names.includes("gate"), "should not have flat 'gate'");
    assert.ok(!names.includes("scan"), "should not have flat 'scan'");
  });

  it("has namespace sections", () => {
    const sections = buildCoreHelpModel({ commands: allCommands, lang: "en" }).topLevelCommands().map((c) => c.section);
    assert.ok(sections.includes("Docs"));
    assert.ok(sections.includes("Flow"));
  });

  it("prints help output via CLI", () => {
    const result = execFileSync("node", [CMD, ...CMD_ARGS_PREFIX], { encoding: "utf8" });
    assert.match(result, /sennel/);
    assert.match(result, /Commands|コマンド一覧/);
  });

  it("prints plugin subcommands via CLI", () => {
    const result = execFileSync("node", [CMD, "plugin", "--help"], { encoding: "utf8" });
    assert.match(result, /Subcommands:/);
    assert.match(result, /source\s+Manage plugin sources/);
    assert.match(result, /find\s+Find installable plugin packages/);
    assert.match(result, /update\s+Update installed plugin packages/);
    assert.doesNotMatch(result, /update-all/);
  });

  it("prints plugin command options via CLI", () => {
    const result = execFileSync("node", [CMD, "plugin", "find", "--help"], { encoding: "utf8" });
    assert.match(result, /Usage: sennel plugin find \[--json\]/);
    assert.match(result, /--json/);
  });
});
