import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  CommandDefinition,
  CommandRegistry,
  coreCommandRegistry,
} from "../../../src/lib/command-registry.js";
import { PluginCatalog, PluginManifest } from "../../../src/lib/plugin-registry.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

describe("CommandDefinition registry", () => {
  it("derives exactly the same help and executable route sets", () => {
    assert.deepEqual(coreCommandRegistry.helpPaths(), coreCommandRegistry.routePaths());
    assert.ok(coreCommandRegistry.routePaths().includes("docs build"));
    assert.ok(coreCommandRegistry.routePaths().includes("check config"));
    assert.ok(coreCommandRegistry.routePaths().includes("spec render"));
    assert.ok(coreCommandRegistry.routePaths().includes("metrics review"));
    assert.ok(!coreCommandRegistry.routePaths().includes("docs snapshot"));
  });

  it("rejects duplicate command registration", () => {
    const registry = new CommandRegistry([
      new CommandDefinition({
        name: "sample",
        help: { summary: "first" },
        entrypoint: { modulePath: "../help.js", invocation: "main" },
      }),
    ]);

    assert.throws(
      () => registry.register(new CommandDefinition({
        name: "sample",
        help: { summary: "duplicate" },
        entrypoint: { modulePath: "../help.js", invocation: "main" },
      })),
      /duplicate command: sample/,
    );
  });

  it("retains flow command dispatch and help metadata in one definition", () => {
    const definition = coreCommandRegistry.find(["flow", "run", "gate"]);
    const flowEntry = FLOW_COMMANDS.run.gate;
    assert.ok(definition instanceof CommandDefinition);
    assert.equal(definition.command, flowEntry.command);
    assert.equal(definition.outputMode, "envelope");
    assert.deepEqual(definition.args, flowEntry.args);
    assert.equal(definition.requiresFlow, flowEntry.requiresFlow);
    assert.equal(definition.runtimeLog, flowEntry.runtimeLog);
    assert.match(definition.help, /Usage: sennel flow run gate/);
    assert.equal(definition.metadata(["flow", "run"]).name, "flow run gate");
  });

  it("describes Version-1 gate and draft-reopen authorities without retired paths", () => {
    const gateHelp = FLOW_COMMANDS.run.gate.help;
    const reopenHelp = FLOW_COMMANDS.run["reopen-draft"].help;
    const autoCheckHelp = FLOW_COMMANDS.run["auto-check"].help;
    const recoverReviewHelp = FLOW_COMMANDS.run["recover-review-pass"].help;
    const requestHelp = FLOW_COMMANDS.set.request.help;
    const issueHelp = FLOW_COMMANDS.set.issue.help;
    const issueLogHelp = FLOW_COMMANDS.set["issue-log"].help;
    const noteHelp = FLOW_COMMANDS.set.note.help;
    const autoHelp = FLOW_COMMANDS.set.auto.help;
    const approvalHelp = FLOW_COMMANDS.set.approval.help;
    const overviewHelp = FLOW_COMMANDS.run["update-overview"].help;
    const testExecuteHelp = FLOW_COMMANDS.run["test-execute"].help;
    const testResultReviewHelp = FLOW_COMMANDS.run["test-result-review"].help;
    const retroHelp = FLOW_COMMANDS.run.retro.help;
    const finalRegressionHelp = FLOW_COMMANDS.run["final-regression"].help;
    const acceptanceReviewHelp = FLOW_COMMANDS.run["acceptance-review"].help;

    assert.match(gateHelp, /active Version-1 Flow/);
    assert.match(gateHelp, /directory \/ spec\.json/);
    assert.doesNotMatch(gateHelp, /legacy spec\.md|auto-resolved from flow\.json/i);
    assert.match(reopenHelp, /typed Version-1 Activity/);
    assert.match(reopenHelp, /cataloged issue-log\.json/);
    assert.doesNotMatch(reopenHelp, /<spec>\/issue-log\.json|flow\.json planRewinds/);
    assert.match(autoCheckHelp, /without adding a\s+mutable autoCheck field to flow\.json/);
    assert.doesNotMatch(autoCheckHelp, /persisted to the active flow\.json autoCheck/);
    assert.match(recoverReviewHelp, /retired projection recovery is never\s+eligible/);
    assert.doesNotMatch(recoverReviewHelp, /immutable review-history artifact|before mutation/);
    assert.match(requestHelp, /active Version-1 request is immutable/);
    assert.doesNotMatch(requestHelp, /Works in both active and preparing mode/);
    assert.match(issueHelp, /Issue identity and issue\.md are immutable/);
    assert.doesNotMatch(issueHelp, /Set the GitHub issue number in flow\.json/);
    assert.match(noteHelp, /typed note Activity/);
    assert.doesNotMatch(noteHelp, /note entry to state\.notes/);
    assert.match(autoHelp, /typed policy Activity/);
    assert.doesNotMatch(autoHelp, /Writes to flow\.json/);
    assert.match(issueLogHelp, /Activity-backed entry.*cataloged issue\.log/);
    assert.doesNotMatch(issueLogHelp, /entry in issue-log\.json/);
    assert.match(approvalHelp, /cataloged spec\.json/);
    assert.match(approvalHelp, /transient Markdown output/);
    assert.doesNotMatch(approvalHelp, /produce spec\.md/);
    assert.match(overviewHelp, /typed spec\.record/);
    assert.doesNotMatch(overviewHelp, /spec\.md is\s+re-rendered/);
    assert.equal(FLOW_COMMANDS.run["impl-confirm"], undefined);
    assert.equal(FLOW_COMMANDS.set.summary, undefined);
    assert.match(testExecuteHelp, /steps\/test-execute\/result\.json/);
    assert.equal(FLOW_COMMANDS.run["scenario-validity"], undefined);
    assert.match(testResultReviewHelp, /steps\/test-result-review\/result\.json/);
    assert.match(retroHelp, /steps\/impl\/retro\/result\.json/);
    assert.equal(FLOW_COMMANDS.run.retro.args.flags.includes("--force"), false);
    assert.match(finalRegressionHelp, /steps\/final-regression\/result\.json/);
    assert.match(acceptanceReviewHelp, /steps\/acceptance-review\/result\.json/);
    for (const help of [testExecuteHelp, testResultReviewHelp, retroHelp, finalRegressionHelp, acceptanceReviewHelp]) {
      assert.doesNotMatch(help, /<configured-spec-root>|tests\/\.raw\/|test-execute-result\.json|test-result-review\.json|retro\.json|final-regression-result\.json|acceptance-review\.json/);
    }
  });

  it("renders the complete canonical help for flow leaf commands", () => {
    const definition = coreCommandRegistry.find(["flow", "resume"]);
    assert.equal(definition.help, FLOW_COMMANDS.resume.help);
    assert.equal(definition.metadata(["flow"]).help, FLOW_COMMANDS.resume.help);
    assert.match(definition.help, /registered active flow/i);
  });
});

describe("plugin command registration", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  function manifest(providerId) {
    const pluginRoot = path.join(root, providerId);
    fs.mkdirSync(pluginRoot, { recursive: true });
    return new PluginManifest(pluginRoot, {
      name: providerId,
      files: ["commands/"],
      contributions: {
        commands: [{ name: "collision", path: "commands/index.js" }],
      },
    }, providerId);
  }

  it("rejects duplicate plugin command contributions", () => {
    root = createTmpDir("plugin-command-duplicate-");
    assert.throws(
      () => new PluginCatalog(root, [manifest("first-plugin"), manifest("second-plugin")]),
      /duplicate plugin command: collision/,
    );
  });

  it("rejects a plugin override of a core command", () => {
    root = createTmpDir("plugin-core-override-");
    assert.throws(
      () => new PluginManifest(root, {
        name: "override-plugin",
        files: ["commands/"],
        contributions: {
          commands: [{ name: "docs", path: "commands/index.js" }],
        },
      }),
      /core command/,
    );
  });
});
