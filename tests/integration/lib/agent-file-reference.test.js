import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import { AgentFileReference } from "../../../src/lib/agent-file-reference.js";
import { AgentFileInputFailure } from "../../../src/lib/agent-file-input-failure.js";
import { captureRegularFile } from "../../../src/lib/regular-file-snapshot.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-file-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "nested"));
  const filePath = path.join(root, "nested", "exact.json");
  fs.writeFileSync(filePath, "Exact あ bytes");
  return { root, filePath, label: "exact input", maxBytes: 100 };
}

it("resolves both paths against explicit root and keeps caller snapshot identity", (t) => {
  const input = fixture(t);
  const absolute = AgentFileReference.resolve({ projectRoot: input.root, ...input });
  const relative = AgentFileReference.resolve({ ...input, projectRoot: input.root, filePath: "nested/exact.json" });
  const snapshot = AgentFileReference.fromSnapshot({ projectRoot: input.root,
    snapshot: captureRegularFile(input.filePath, input) });
  assert.deepEqual(relative, absolute);
  assert.deepEqual(snapshot, absolute);
  assert.equal(absolute.byteLength, Buffer.byteLength("Exact あ bytes"));
  assert.equal(path.resolve(absolute.projectRoot, absolute.projectRelativePath), absolute.absolutePath);
  assert.match(absolute.toPromptText(), /never against your current working directory/);
  assert.ok(Object.isFrozen(absolute));
});

it("rejects missing files, directory, escape, symlinks, read errors and opening identity changes", (t) => {
  const input = fixture(t);
  fs.symlinkSync(input.filePath, path.join(input.root, "link.json"));
  for (const filePath of ["missing", "nested", "../outside", "link.json"]) {
    assert.throws(() => AgentFileReference.resolve({ ...input, projectRoot: input.root, filePath }), AgentFileInputFailure);
  }
  const originalOpen = fs.openSync;
  const unreadable = mock.method(fs, "openSync", () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
  try { assert.throws(() => AgentFileReference.resolve({ ...input, projectRoot: input.root }), /permission denied/); }
  finally { unreadable.mock.restore(); }
  const originalStat = fs.fstatSync;
  const changed = mock.method(fs, "fstatSync", (...args) => {
    const stat = originalStat(...args); stat.ino += 1; return stat;
  });
  try { assert.throws(() => AgentFileReference.resolve({ ...input, projectRoot: input.root }), /identity changed/); }
  finally { changed.mock.restore(); }
  assert.equal(fs.openSync, originalOpen);
});

it("refuses changed or missing bytes before retry instead of adopting replacement content", (t) => {
  const input = fixture(t);
  const reference = AgentFileReference.resolve({ ...input, projectRoot: input.root });
  reference.assertUnchanged(input);
  fs.writeFileSync(input.filePath, "Other あ bytes");
  assert.throws(() => reference.assertUnchanged(input), /bytes changed/);
  fs.unlinkSync(input.filePath);
  assert.throws(() => reference.assertUnchanged(input), /unavailable/);
});
