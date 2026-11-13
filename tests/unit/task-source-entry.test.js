import assert from "node:assert/strict";
import { it } from "node:test";
import { CurrentTaskSourceFile, CurrentTaskSourceDirectory, CurrentTaskSourceDeletion } from "../../src/flow/lib/task-mutation-lineage.js";

it("renders certified source file bytes as their text presentation", () => {
  const entry = new CurrentTaskSourceFile({ path: "src/file.js", content: "source\n", digest: "a".repeat(64) });
  assert.equal(entry.toMarkdown(), "## src/file.js\nsource\n");
  assert.equal(entry.sourceKind, "file");
  assert.equal(entry.contentDigest, "a".repeat(64));
});

it("renders a directory explicitly without inventing file content or digest", () => {
  const entry = new CurrentTaskSourceDirectory({ path: "src/empty" });
  assert.equal(entry.toMarkdown(), "## src/empty\n(directory)");
  assert.deepEqual(entry.toJSON(), { path: "src/empty", status: "directory" });
  assert.equal(entry.sourceKind, "directory");
  assert.equal(entry.contentDigest, null);
});

it("renders a deleted certified source path explicitly", () => {
  const entry = new CurrentTaskSourceDeletion({ path: "old.js" });
  assert.equal(entry.toMarkdown(), "## old.js\n(deleted)");
  assert.equal(entry.sourceKind, "missing");
  assert.equal(entry.contentDigest, null);
});
