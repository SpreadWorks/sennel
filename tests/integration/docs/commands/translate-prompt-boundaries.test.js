import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createTmpDir, removeTmpDir, writeFile } from "../../../support/builders/tmp-dir.js";
import DocsTranslateCommand from "../../../../src/docs/commands/translate.js";

describe("translate prompt boundaries", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("keeps an existing target unchanged when a blockquote code fence is changed by the translation response", async () => {
    tmp = createTmpDir();
    const docsDir = path.join(tmp, "docs");
    const targetPath = path.join(docsDir, "ja", "overview.md");
    const content = "Before prose.\n\n> ```js\n> const stable = 1;\n> ```\n\nAfter prose.\n";
    const existingTarget = "既存の翻訳\n";
    writeFile(tmp, "docs/overview.md", content);
    writeFile(tmp, "docs/ja/overview.md", existingTarget);
    const agent = {
      resolve: () => true,
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [
          id,
          id.endsWith(":block:1") || id.endsWith(":block:3")
            ? "\n"
            : id.endsWith(":block:2")
              ? "> ```js\n> const changed = 1;\n> ```\n"
              : "translated\n",
        ])));
      },
    };
    const ctx = {
      root: tmp,
      docsDir,
      config: {
        type: "sample-node-command",
        concurrency: 1,
        agent: { promptCharacterLimit: 4000 },
        chapters: ["overview.md"],
        docs: { mode: "translate", languages: ["en", "ja"], defaultLanguage: "en" },
      },
      type: "sample-node-command",
      force: true,
      dryRun: false,
      targetLang: "ja",
      agent,
    };

    await assert.rejects(new DocsTranslateCommand().execute({ docsCtx: ctx, _rawArgs: [] }), /Prompt batch execution/);
    assert.equal(fs.readFileSync(targetPath, "utf8"), existingTarget);
  });

  it("rejects an oversized blockquote code fence before provider admission", async () => {
    tmp = createTmpDir();
    const docsDir = path.join(tmp, "docs");
    const targetPath = path.join(docsDir, "ja", "overview.md");
    const existingTarget = "既存の翻訳\n";
    const content = `> \`\`\`js\n> ${"x".repeat(9_200)}\n> \`\`\`\n`;
    writeFile(tmp, "docs/overview.md", content);
    writeFile(tmp, "docs/ja/overview.md", existingTarget);
    let calls = 0;
    const agent = {
      resolve: () => true,
      async call() {
        calls += 1;
        return "{}";
      },
    };
    const ctx = {
      root: tmp,
      docsDir,
      config: {
        type: "sample-node-command",
        concurrency: 1,
        agent: { promptCharacterLimit: 4000 },
        chapters: ["overview.md"],
        docs: { mode: "translate", languages: ["en", "ja"], defaultLanguage: "en" },
      },
      type: "sample-node-command",
      force: true,
      dryRun: false,
      targetLang: "ja",
      agent,
    };

    await assert.rejects(new DocsTranslateCommand().execute({ docsCtx: ctx, _rawArgs: [] }), (error) => {
      assert.equal(error.code, "CONCURRENT_BATCH_FAILED");
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0].error.code, "PROMPT_ELEMENT_TOO_LARGE");
      return true;
    });
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(targetPath, "utf8"), existingTarget);
  });
});
