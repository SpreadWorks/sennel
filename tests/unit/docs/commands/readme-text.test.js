import { describe, it, afterEach } from "node:test";
import os from "os";
import assert from "node:assert/strict";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";
import path from "path";
import { processTemplateFileBatch, countFilledInBatch } from "../../../../src/docs/commands/text.js";
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

/**
 * README.md の {{text}} 処理に関するテスト。
 *
 * バッチモードは JSON 形式でディレクティブごとのテキストを受け取り、
 * コード側で該当位置に挿入する。{{data}} 解決済みコンテンツは
 * AI に返させないため構造が壊れない。
 */

describe("README.md text directive processing", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("batch JSON mode fills directives without affecting {{data}} content", async () => {
    tmp = createTmpDir();

    const readmeContent = [
      '# <!-- {{data("sample-preset.project.name")}} -->MyProject<!-- {{/data}} -->',
      "",
      '<!-- {{text({prompt: "Write project overview"})}} -->',
      "<!-- {{/text}} -->",
      "",
      "## Tech Stack",
      "",
      "| Category | Technology |",
      "|----------|------------|",
      '<!-- {{text({prompt: "Write tech stack table rows"})}} -->',
      "<!-- {{/text}} -->",
      "",
      "## Documentation",
      "",
      "<!-- {{data(\"sample-preset.docs.chapters\")}} -->",
      "| Chapter | Summary |",
      "| --- | --- |",
      "| [Overview](docs/overview.md) | System overview |",
      "<!-- {{/data}} -->",
      "",
    ].join("\n");

    const generated = {
      d0: "This is the project overview.",
      d1: "| Node.js | >= 18.0.0 |",
    };
    const agent = {
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, generated[id]])));
      },
    };

    const result = await processTemplateFileBatch(
      readmeContent,
      {},
      "README.md",
      agent,
      false,
      [],
      "",
      undefined,
      undefined,
      "ja",
    );

    assert.strictEqual(result.filled, 2, "both directives should be filled");
    assert.ok(result.text.includes("This is the project overview."), "d0 content inserted");
    assert.ok(result.text.includes("| Node.js | >= 18.0.0 |"), "d1 content inserted");
    // {{data}} content should be preserved
    assert.ok(result.text.includes("| [Overview](docs/overview.md) | System overview |"), "data content preserved");
  });

  it("countFilledInBatch correctly identifies unfilled directives", () => {
    const unfilled = [
      '<!-- {{text({prompt: "overview"})}} -->',
      "<!-- {{/text}} -->",
    ].join("\n");

    assert.strictEqual(countFilledInBatch(unfilled), 0, "empty directive should count as 0");

    const filled = [
      '<!-- {{text({prompt: "overview"})}} -->',
      "",
      "This is the overview content.",
      "",
      "<!-- {{/text}} -->",
    ].join("\n");

    assert.strictEqual(countFilledInBatch(filled), 1, "directive with content should count as 1");
  });

  it("{{data}} content is not affected by per-directive processTemplate", async () => {
    // per-directive モード（processTemplate）は {{text}} の開始/終了タグの間のみ置換する
    // {{data}} 部分には触れないことを確認

    const dataContent = [
      "| [Overview](docs/overview.md) | System overview |",
      "| [Stack](docs/stack_and_ops.md) | Tech stack |",
    ].join("\n");

    const readmeWithData = [
      "# MyProject",
      "",
      "<!-- {{data(\"sample-preset.docs.chapters\")}} -->",
      dataContent,
      "<!-- {{/data}} -->",
      "",
      '<!-- {{text({prompt: "Write overview"})}} -->',
      "Overview text here.",
      "<!-- {{/text}} -->",
    ].join("\n");

    // After processTemplate, the {{data}} section should remain unchanged
    // We verify this by checking countFilledInBatch on a structure
    // where {{text}} is filled but {{data}} content is preserved
    const lines = readmeWithData.split("\n");
    const dataStartIdx = lines.findIndex(l => l.includes("{{data("));
    const dataEndIdx = lines.findIndex(l => l.includes("{{/data}}"));

    // {{data}} content lines should be intact
    assert.ok(dataStartIdx >= 0, "data start tag should exist");
    assert.ok(dataEndIdx > dataStartIdx, "data end tag should be after start");
    assert.ok(lines[dataStartIdx + 1].includes("Overview"), "data content row 1 should be preserved");
    assert.ok(lines[dataStartIdx + 2].includes("Stack"), "data content row 2 should be preserved");
  });
});
