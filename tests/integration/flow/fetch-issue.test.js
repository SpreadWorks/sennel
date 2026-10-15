import { offlineGitHubScript } from "../../support/fakes/github.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fetchIssue } from "../../../src/flow/lib/fetch-issue.js";

function writeFakeGh(dir, body) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "gh");
  fs.writeFileSync(script, body, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  return bin;
}

function withPath(binDir) {
  const saved = process.env.PATH;
  process.env.PATH = `${binDir}:${saved}`;
  return () => {
    process.env.PATH = saved;
  };
}

function captureStderr() {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  return {
    get() { return writes.join(""); },
    restore() { process.stderr.write = original; },
  };
}

describe("fetch-issue helper (spec 225 R2)", () => {
  let tmp;
  let restorePath;

  beforeEach(() => { tmp = createTmpDir("fetch-issue-"); });
  afterEach(() => {
    removeTmpDir(tmp);
    if (restorePath) { restorePath(); restorePath = null; }
  });

  describe("strict: true", () => {
    it("returns parsed shape on gh success", () => {
      const bin = writeFakeGh(tmp, offlineGitHubScript({ title: "Test Issue", body: "body text", labels: ["bug"] }));
      restorePath = withPath(bin);

      const out = fetchIssue(42, tmp, { strict: true });
      assert.equal(out.title, "Test Issue");
      assert.equal(out.body, "body text");
      assert.equal(out.state, "open");
      assert.deepEqual(out.labels, ["bug"]);
    });

    it("throws when gh exits non-zero", () => {
      const bin = writeFakeGh(tmp, `#!/bin/sh
echo "gh: not found" >&2
exit 1
`);
      restorePath = withPath(bin);

      assert.throws(() => fetchIssue(42, tmp, { strict: true }));
    });

    it("throws when gh stdout is not JSON", () => {
      const bin = writeFakeGh(tmp, `#!/bin/sh
echo "not json"
`);
      restorePath = withPath(bin);

      assert.throws(() => fetchIssue(42, tmp, { strict: true }));
    });

    it("throws when gh binary is missing (no gh on PATH)", () => {
      // Point PATH to empty directory so 'gh' is not found.
      const empty = path.join(tmp, "empty-bin");
      fs.mkdirSync(empty, { recursive: true });
      restorePath = withPath(empty);
      // Overwrite PATH entirely to exclude system gh.
      const savedPath = process.env.PATH;
      process.env.PATH = empty;
      try {
        assert.throws(() => fetchIssue(42, tmp, { strict: true }));
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });

  describe("strict: false (lenient)", () => {
    it("returns parsed shape on gh success", () => {
      const bin = writeFakeGh(tmp, offlineGitHubScript({ title: "Lenient OK", body: "ok body" }));
      restorePath = withPath(bin);

      const out = fetchIssue(7, tmp, { strict: false });
      assert.equal(out.title, "Lenient OK");
      assert.equal(out.body, "ok body");
    });

    it("returns null on gh failure and emits 1 line warning to stderr", () => {
      const bin = writeFakeGh(tmp, `#!/bin/sh
echo "token=private-test-credential\nraw private stderr" >&2
exit 1
`);
      restorePath = withPath(bin);

      const cap = captureStderr();
      try {
        const out = fetchIssue(9, tmp, { strict: false });
        assert.equal(out, null);
        const stderrOut = cap.get();
        assert.match(stderrOut, /warn:/);
        assert.match(stderrOut, /9: GITHUB_PROCESS_FAILURE/);
        assert.equal(stderrOut.trim().split("\n").length, 1);
        assert.doesNotMatch(stderrOut, /private-test-credential|raw private stderr/);
      } finally {
        cap.restore();
      }
    });

    it("returns null on parse failure and emits warning", () => {
      const bin = writeFakeGh(tmp, `#!/bin/sh
echo "garbage"
`);
      restorePath = withPath(bin);

      const cap = captureStderr();
      try {
        const out = fetchIssue(11, tmp, { strict: false });
        assert.equal(out, null);
        assert.match(cap.get(), /warn:/);
      } finally {
        cap.restore();
      }
    });

    it("stderr warning is one line", () => {
      const bin = writeFakeGh(tmp, `#!/bin/sh
exit 1
`);
      restorePath = withPath(bin);

      const cap = captureStderr();
      try {
        fetchIssue(13, tmp, { strict: false });
        const text = cap.get();
        const lines = text.trim().split("\n");
        assert.equal(lines.length, 1, `expected exactly one warning line, got ${lines.length}: ${JSON.stringify(text)}`);
      } finally {
        cap.restore();
      }
    });
  });
});
