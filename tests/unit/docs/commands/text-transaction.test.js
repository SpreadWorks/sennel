import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import DocsTextCommand from "../../../../src/docs/commands/text.js";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";

function template(title) {
  return [
    `# ${title}`,
    "",
    '<!-- {{text({prompt: "describe this section"})}} -->',
    "old generated content",
    "<!-- {{/text}} -->",
    "",
  ].join("\n");
}

function setup(root, names) {
  const docsDir = path.join(root, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const files = names.map((name) => path.join(docsDir, name));
  files.forEach((file, index) => fs.writeFileSync(file, template(`Doc ${index + 1}`)));
  return { docsDir, files, before: files.map((file) => fs.readFileSync(file)) };
}

function context(root, docsDir, files, agent, extra = {}) {
  return {
    root,
    srcRoot: root,
    docsDir,
    files: files.map((file) => path.basename(file)),
    config: {
      type: "sample-node-command",
      concurrency: 2,
      agent: { retryCount: 0 },
      docs: { defaultLanguage: "en" },
    },
    type: "sample-node-command",
    outputLang: "en",
    commandId: "docs.text",
    dryRun: false,
    perDirective: false,
    force: false,
    agent,
    ...extra,
  };
}

function assertOriginalBytes(files, before) {
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
}

async function execute(ctx) {
  return new DocsTextCommand().execute({ docsCtx: ctx, _rawArgs: [] });
}

describe("docs text transaction", () => {
  for (const [name, call, pattern] of [
    ["agent failure", async () => { throw new Error("agent failed"); }, /Prompt batch execution/],
    ["invalid JSON", async () => "not JSON", /Prompt batch execution/],
    ["empty response", async () => "", /Prompt batch execution/],
  ]) {
    it(`keeps the target byte-identical on ${name}`, async () => {
      const root = createTmpDir(`docs-text-${name.replaceAll(" ", "-")}-`);
      try {
        const fixture = setup(root, ["overview.md"]);
        const agent = { resolve: () => true, call };
        await assert.rejects(execute(context(root, fixture.docsDir, fixture.files, agent)), pattern);
        assertOriginalBytes(fixture.files, fixture.before);
      } finally {
        removeTmpDir(root);
      }
    });
  }

  it("does not commit a successful file from a partial concurrent batch", async () => {
    const root = createTmpDir("docs-text-partial-batch-");
    try {
      const fixture = setup(root, ["overview.md", "cli_commands.md"]);
      let calls = 0;
      const agent = {
        resolve: () => true,
        async call() {
          calls += 1;
          if (calls === 2) throw new Error("second file failed");
          return JSON.stringify({ d0: "new generated content" });
        },
      };
      await assert.rejects(
        execute(context(root, fixture.docsDir, fixture.files, agent)),
        /Prompt batch execution/,
      );
      assertOriginalBytes(fixture.files, fixture.before);
    } finally {
      removeTmpDir(root);
    }
  });

  it("rolls back every file when a later atomic commit fails", async () => {
    const root = createTmpDir("docs-text-commit-failure-");
    try {
      const fixture = setup(root, ["overview.md", "cli_commands.md"]);
      const agent = {
        resolve: () => true,
        call: async () => JSON.stringify({ d0: "new generated content" }),
      };
      const ctx = context(root, fixture.docsDir, fixture.files, agent, {
        faultInjector(event) {
          if (event.filePath === fixture.files[1] && event.phase === "before-file-rename") {
            throw new Error("second text commit failed");
          }
        },
      });

      await assert.rejects(execute(ctx), /second text commit failed/);
      assertOriginalBytes(fixture.files, fixture.before);
    } finally {
      removeTmpDir(root);
    }
  });
});
