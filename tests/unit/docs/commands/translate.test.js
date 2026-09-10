import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createTmpDir, removeTmpDir, writeFile } from "../../../support/builders/tmp-dir.js";
import DocsTranslateCommand, { buildTranslationTasks, translateDocument } from "../../../../src/docs/commands/translate.js";

describe("translate parallel", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  describe("buildTranslationTasks", () => {
    it("flattens lang × files into a single task list", () => {
      tmp = createTmpDir();
      const docsDir = path.join(tmp, "docs");
      fs.mkdirSync(docsDir, { recursive: true });
      writeFile(tmp, "docs/overview.md", "# Overview");
      writeFile(tmp, "docs/design.md", "# Design");
      writeFile(tmp, "README.md", "# README");

      const tasks = buildTranslationTasks({
        sourceFiles: ["overview.md", "design.md"],
        targetLangs: ["ja", "zh"],
        docsDir,
        readmePath: path.join(tmp, "README.md"),
        hasReadme: true,
        force: true,
      });

      // 2 langs × (2 chapters + 1 readme) = 6 tasks
      assert.equal(tasks.length, 6);

      // Each task has lang, sourcePath, targetPath, label
      for (const t of tasks) {
        assert.ok(t.lang);
        assert.ok(t.sourcePath);
        assert.ok(t.targetPath);
        assert.ok(t.label);
      }

      // Verify both languages are represented
      const langs = [...new Set(tasks.map((t) => t.lang))];
      assert.deepEqual(langs.sort(), ["ja", "zh"]);

      // Verify README is included
      const readmeTasks = tasks.filter((t) => t.label.includes("README"));
      assert.equal(readmeTasks.length, 2);
    });

    it("filters out up-to-date files when force is false", () => {
      tmp = createTmpDir();
      const docsDir = path.join(tmp, "docs");
      fs.mkdirSync(path.join(docsDir, "ja"), { recursive: true });
      writeFile(tmp, "docs/overview.md", "# Overview");
      writeFile(tmp, "docs/design.md", "# Design");

      // Make ja/overview.md newer than source (up-to-date)
      writeFile(tmp, "docs/ja/overview.md", "# 概要");
      const src = path.join(docsDir, "overview.md");
      const tgt = path.join(docsDir, "ja", "overview.md");
      const past = new Date(Date.now() - 10000);
      fs.utimesSync(src, past, past);

      const tasks = buildTranslationTasks({
        sourceFiles: ["overview.md", "design.md"],
        targetLangs: ["ja"],
        docsDir,
        readmePath: path.join(tmp, "README.md"),
        hasReadme: false,
        force: false,
      });

      // overview.md should be skipped (target is newer), design.md should be included
      assert.equal(tasks.length, 1);
      assert.ok(tasks[0].label.includes("design.md"));
    });

    it("includes all files when force is true", () => {
      tmp = createTmpDir();
      const docsDir = path.join(tmp, "docs");
      fs.mkdirSync(path.join(docsDir, "ja"), { recursive: true });
      writeFile(tmp, "docs/overview.md", "# Overview");
      // Target is newer
      writeFile(tmp, "docs/ja/overview.md", "# 概要");
      const src = path.join(docsDir, "overview.md");
      const past = new Date(Date.now() - 10000);
      fs.utimesSync(src, past, past);

      const tasks = buildTranslationTasks({
        sourceFiles: ["overview.md"],
        targetLangs: ["ja"],
        docsDir,
        readmePath: path.join(tmp, "README.md"),
        hasReadme: false,
        force: true,
      });

      assert.equal(tasks.length, 1);
    });

    it("returns empty array when no files need translation", () => {
      tmp = createTmpDir();
      const docsDir = path.join(tmp, "docs");
      fs.mkdirSync(path.join(docsDir, "ja"), { recursive: true });
      writeFile(tmp, "docs/overview.md", "# Overview");
      writeFile(tmp, "docs/ja/overview.md", "# 概要");
      const src = path.join(docsDir, "overview.md");
      const past = new Date(Date.now() - 10000);
      fs.utimesSync(src, past, past);

      const tasks = buildTranslationTasks({
        sourceFiles: ["overview.md"],
        targetLangs: ["ja"],
        docsDir,
        readmePath: path.join(tmp, "README.md"),
        hasReadme: false,
        force: false,
      });

      assert.equal(tasks.length, 0);
    });
  });

  it("preserves Markdown structural blocks while translating typed block results", async () => {
    const content = "# Heading\n\n```js\nconst x = 1;\n```\n";
    const agent = {
      resolve: () => true,
      async call(_prompt, options) {
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => {
          if (id.endsWith(":block:0")) return [id, "# 見出し\n"];
          if (id.endsWith(":block:1")) return [id, "\n"];
          return [id, "```js\nconst x = 1;\n```\n"];
        })));
      },
    };
    const translated = await translateDocument(content, "en", "ja", agent, "fixture", {}, {
      documentId: "fixture",
      maxCharacters: 4000,
    });
    assert.equal(translated, "# 見出し\n\n```js\nconst x = 1;\n```\n");
  });

  it("publishes no target file when one translation batch fails", async () => {
    tmp = createTmpDir();
    const docsDir = path.join(tmp, "docs");
    writeFile(tmp, "docs/one.md", "first paragraph");
    writeFile(tmp, "docs/two.md", "second paragraph");
    let calls = 0;
    const agent = {
      resolve: () => true,
      async call(_prompt, options) {
        calls += 1;
        if (calls === 2) throw new Error("translation failed");
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, "translated"])));
      },
    };
    const ctx = {
      root: tmp,
      docsDir,
      config: {
        type: "sample-node-command",
        concurrency: 2,
        agent: { promptCharacterLimit: 4000 },
        chapters: ["one.md", "two.md"],
        docs: { mode: "translate", languages: ["en", "ja"], defaultLanguage: "en" },
      },
      type: "sample-node-command",
      force: true,
      dryRun: false,
      targetLang: "ja",
      agent,
    };
    await assert.rejects(new DocsTranslateCommand().execute({ docsCtx: ctx, _rawArgs: [] }), /Prompt batch execution/);
    assert.equal(fs.existsSync(path.join(docsDir, "ja", "one.md")), false);
    assert.equal(fs.existsSync(path.join(docsDir, "ja", "two.md")), false);
  });

  it("publishes no target file when a later translation returns blank block text", async () => {
    tmp = createTmpDir();
    const docsDir = path.join(tmp, "docs");
    writeFile(tmp, "docs/one.md", "first paragraph");
    writeFile(tmp, "docs/two.md", "second paragraph");
    let calls = 0;
    const agent = {
      resolve: () => true,
      async call(_prompt, options) {
        calls += 1;
        const translated = calls === 2 ? "" : "translated";
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, translated])));
      },
    };
    const ctx = {
      root: tmp,
      docsDir,
      config: {
        type: "sample-node-command",
        concurrency: 1,
        agent: { promptCharacterLimit: 4000 },
        chapters: ["one.md", "two.md"],
        docs: { mode: "translate", languages: ["en", "ja"], defaultLanguage: "en" },
      },
      type: "sample-node-command",
      force: true,
      dryRun: false,
      targetLang: "ja",
      agent,
    };
    await assert.rejects(new DocsTranslateCommand().execute({ docsCtx: ctx, _rawArgs: [] }), /Prompt batch execution/);
    assert.equal(fs.existsSync(path.join(docsDir, "ja", "one.md")), false);
    assert.equal(fs.existsSync(path.join(docsDir, "ja", "two.md")), false);
  });
});
