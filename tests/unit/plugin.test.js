import { createTmpDir as createTestDirectory } from "../support/builders/tmp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { readPromptLine } from "../../src/plugin.js";

function withInputFile(content, fn) {
  const dir = createTestDirectory("sennel-plugin-prompt-");
  const file = path.join(dir, "input.txt");
  fs.writeFileSync(file, content, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    return fn(fd);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("plugin prompt input", () => {
  it("reads only one line from stdin", () => {
    withInputFile("yes\nno\n", (fd) => {
      assert.equal(readPromptLine(fd), "yes\n");

      const remaining = Buffer.alloc(3);
      assert.equal(fs.readSync(fd, remaining, 0, remaining.length, null), 3);
      assert.equal(remaining.toString("utf8"), "no\n");
    });
  });

  it("accepts EOF-terminated input without a trailing newline", () => {
    withInputFile("y", (fd) => {
      assert.equal(readPromptLine(fd), "y");
    });
  });
});
