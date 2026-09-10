import { describe, it, afterEach } from "node:test";
import os from "os";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";
import { processTemplateFileBatch } from "../../../../src/docs/commands/text.js";
import { Agent } from "../../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../../src/lib/provider.js";
import { Logger } from "../../../../src/lib/log.js";

function makeAgent(profile, root) {
  const config = { agent: { default: "test/exec", providers: { "test/exec": profile }, timeout: 300 } };
  const registry = new ProviderRegistry(config.agent.providers);
  return new Agent({
    config,
    paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry,
    logger: new Logger({ logDir: os.tmpdir(), enabled: false }),
  });
}

describe("processTemplateFileBatch", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("fills {{text}} directives using echo agent", async () => {
    tmp = createTmpDir();

    const templateContent = [
      "# Test Document",
      "",
      "## Overview",
      '<!-- {{text({prompt: "describe the overview"})}} -->',
      "<!-- {{/text}} -->",
      "",
      "## Details",
      '<!-- {{text({prompt: "describe the details"})}} -->',
      "<!-- {{/text}} -->",
      "",
    ].join("\n");

    const generated = {
      d0: "This is the overview.",
      d1: "These are the details.",
    };
    const agent = {
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, generated[id]])));
      },
    };

    const result = await processTemplateFileBatch(
      templateContent,
      { structure: {} },
      "test.md",
      agent,
      false,
      [],
      "",
      undefined,
      undefined,
      "en",
    );

    assert.ok(result, "should return a result");
    assert.ok(typeof result.text === "string", "result.text should be a string");
    assert.ok(typeof result.filled === "number", "result.filled should be a number");
  });

  it("binds the agent to the current source root", async () => {
    tmp = createTmpDir();
    const calls = [];
    const agent = {
      async call(_prompt, options) {
        calls.push(options);
        return JSON.stringify({ d0: "Grounded content." });
      },
    };
    const templateContent = [
      "# Test Document",
      '<!-- {{text({prompt: "describe the project"})}} -->',
      "<!-- {{/text}} -->",
      "",
    ].join("\n");

    await processTemplateFileBatch(
      templateContent,
      { analyzedAt: "2026-08-14T00:00:00.000Z" },
      "test.md",
      agent,
      false,
      [],
      "",
      undefined,
      undefined,
      "en",
      tmp,
    );

    assert.equal(calls.length, 1);
    for (const options of calls) {
      assert.equal(options.executionWorkDir, tmp);
      assert.equal(options.flowAttribution, "none");
      assert.equal(typeof options.providerCallAdmission?.claim, "function");
    }
  });

  it("replaces existing content between {{text}} tags without duplicating opening tag", async () => {
    tmp = createTmpDir();

    // 2回目の実行を想定: すでにコンテンツが挿入済みのテンプレート
    const templateContent = [
      "# Test Document",
      "",
      "## Overview",
      '<!-- {{text({prompt: "describe the overview"})}} -->',
      "",
      "Old overview content that should be replaced.",
      "",
      "<!-- {{/text}} -->",
      "",
      "## Details",
      '<!-- {{text({prompt: "describe the details"})}} -->',
      "",
      "Old details content.",
      "",
      "<!-- {{/text}} -->",
      "",
    ].join("\n");

    const generated = {
      d0: "New overview content.",
      d1: "New details content.",
    };
    const agent = {
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, generated[id]])));
      },
    };

    const result = await processTemplateFileBatch(
      templateContent,
      { structure: {} },
      "test.md",
      agent,
      false,
      [],
      "",
      undefined,
      undefined,
      "en",
    );

    assert.ok(result, "should return a result");
    assert.ok(typeof result.text === "string", "result.text should be a string");

    // 開きタグが重複していないこと
    const openTagCount = (result.text.match(/<!-- {{text\(/g) || []).length;
    assert.strictEqual(openTagCount, 2, `opening tags should appear exactly twice, got ${openTagCount}`);

    // 閉じタグが重複していないこと
    const closeTagCount = (result.text.match(/<!-- {{\/text}} -->/g) || []).length;
    assert.strictEqual(closeTagCount, 2, `closing tags should appear exactly twice, got ${closeTagCount}`);

    // 新しいコンテンツが含まれていること
    assert.ok(result.text.includes("New overview content."), "should contain new overview content");
    assert.ok(result.text.includes("New details content."), "should contain new details content");

    // 古いコンテンツが残っていないこと
    assert.ok(!result.text.includes("Old overview content"), "should not contain old overview content");
    assert.ok(!result.text.includes("Old details content"), "should not contain old details content");

    assert.strictEqual(result.filled, 2);
  });

  it("returns null text on empty agent response in dry-run", async () => {
    tmp = createTmpDir();

    const templateContent = [
      "# Test Document",
      "## Section",
      '<!-- {{text({prompt: "describe"})}} -->',
      "<!-- {{/text}} -->",
      "",
    ].join("\n");

    // agent that returns empty
    const agent = makeAgent({
      command: "echo",
      args: ["-n", ""],
    }, tmp);

    const result = await processTemplateFileBatch(
      templateContent,
      { structure: {} },
      "test.md",
      agent,
      true,
      [],
      "",
      undefined,
      undefined,
      "en",
    );

    // dry-run returns original text unchanged with filled=0
    assert.strictEqual(result.text, templateContent);
    assert.strictEqual(result.filled, 0);
    assert.strictEqual(result.skipped, 1);
  });

  it("preserves unselected generated content when filtering by directive ID", async () => {
    tmp = createTmpDir();
    const templateContent = [
      "# Test Document",
      '<!-- {{text({prompt: "first", id: "one"})}} -->',
      "OLD ONE",
      "<!-- {{/text}} -->",
      '<!-- {{text({prompt: "second", id: "two"})}} -->',
      "OLD TWO",
      "<!-- {{/text}} -->",
      "",
    ].join("\n");
    const agent = {
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, "NEW ONE"])));
      },
    };

    const result = await processTemplateFileBatch(
      templateContent,
      {},
      "test.md",
      agent,
      false,
      [],
      "",
      "one",
      1,
      "en",
      tmp,
      0,
      4000,
    );

    assert.match(result.text, /NEW ONE/);
    assert.doesNotMatch(result.text, /OLD ONE/);
    assert.match(result.text, /OLD TWO/);
    assert.equal(result.filled, 1);
  });
});
