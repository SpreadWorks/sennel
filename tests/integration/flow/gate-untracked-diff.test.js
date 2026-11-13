/**
 * tests/integration/flow/gate-untracked-diff.test.js
 *
 * spec 221: impl-gate が untracked な新規ファイルを diff 評価で見落とす不具合の修正。
 *
 * `collectUntrackedDiff(root, options?)` は worktree 内の untracked ファイル
 * (`.gitignore` 除外を除く) を列挙し、各ファイルを `/dev/null` 比較の unified
 * diff として連結した文字列を返す純粋関数。
 *
 * - REQ-1/REQ-2: untracked ファイルが標準 unified diff 形式 (`+` のみの hunk)
 *   として返る。
 * - REQ-3: untracked が 0 件なら空文字列を返す。
 * - REQ-4: 呼び出し前後で `git status --porcelain` が変化しない (副作用ゼロ)。
 * - REQ-5: 純粋関数として `(root)` のみを入力に取り、外部状態に書き込まない。
 * - REQ-6: 件数 500 / ファイルサイズ 1 MiB の上限を超えると `UNTRACKED_LIMIT_EXCEEDED`
 *   コードを持つ Error を throw する。診断メッセージに観測値と上限を含める。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { devNull } from "node:os";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "../../../src/flow/lib/flow-repository-runtime-artifacts.js";
import {
  collectUntrackedDiff,
} from "../../../src/flow/lib/run-gate.js";

function initRepo() {
  const root = createTmpDir("sennel-gate-untracked-");
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  // Provide a starting commit so `git status` / `git ls-files` behave
  // identically to a normal repository.
  execFileSync(
    "git",
    ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
     "commit", "--allow-empty", "--quiet", "-m", "init"],
    { encoding: "utf8" },
  );
  return root;
}

function porcelain(root) {
  return execFileSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf8",
  });
}

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { removeTmpDir(d); } catch { /* ignore cleanup errors */ }
  }
});

function newRepo() {
  const root = initRepo();
  tmpDirs.push(root);
  return root;
}

describe("collectUntrackedDiff — happy path", () => {
  it("REQ-3: returns empty string when no untracked files exist", async () => {
    const root = newRepo();
    const out = await collectUntrackedDiff(root);
    assert.equal(out, "");
  });

  it("REQ-1/REQ-2: includes a new untracked test file as a + only hunk", async () => {
    const root = newRepo();
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    const body = [
      "import { describe, it } from 'node:test';",
      "describe('x', () => {",
      "  it('passes', () => {});",
      "});",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(root, "tests/foo.test.js"), body);

    const out = await collectUntrackedDiff(root);
    assert.match(out, /tests\/foo\.test\.js/);
    // every content line of the new file must appear as a `+` line
    assert.match(out, /^\+import \{ describe, it \} from 'node:test';$/m);
    assert.match(out, /^\+describe\('x', \(\) => \{$/m);
  });

  it("REQ-1: includes a new untracked src file too (no test-only filter)", async () => {
    const root = newRepo();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/new-mod.js"), "export const x = 1;\n");
    const out = await collectUntrackedDiff(root);
    assert.match(out, /src\/new-mod\.js/);
    assert.match(out, /^\+export const x = 1;$/m);
  });

  it("REQ-2: synthesized diff parses cleanly when concatenated with tracked diff", async () => {
    const root = newRepo();
    // tracked file with a modification
    fs.writeFileSync(path.join(root, "tracked.js"), "old\n");
    execFileSync("git", ["-C", root, "add", "tracked.js"], { encoding: "utf8" });
    execFileSync(
      "git",
      ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
       "commit", "--quiet", "-m", "add tracked"],
      { encoding: "utf8" },
    );
    fs.writeFileSync(path.join(root, "tracked.js"), "new\n");

    // untracked test file
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tests/bar.test.js"),
      ["import { it } from 'node:test';", "it('a', () => {});", ""].join("\n"),
    );

    const tracked = execFileSync("git", ["-C", root, "diff", "HEAD"], {
      encoding: "utf8",
    });
    const untracked = await collectUntrackedDiff(root);
    const combined = tracked + untracked;

    assert.match(combined, /tracked\.js/);
    assert.match(combined, /tests\/bar\.test\.js/);
  });
});

describe("collectUntrackedDiff — purity / no side effects", () => {
  it("REQ-4: git status --porcelain is identical before and after the call", async () => {
    const root = newRepo();
    fs.writeFileSync(path.join(root, "untracked-a.js"), "a\n");
    fs.writeFileSync(path.join(root, "untracked-b.js"), "b\n");

    const before = porcelain(root);
    await collectUntrackedDiff(root);
    const after = porcelain(root);

    assert.equal(after, before);
  });

  it("REQ-5: helper takes only `root` (and optional limits) and returns a string", async () => {
    const root = newRepo();
    fs.writeFileSync(path.join(root, "x.js"), "x\n");
    const out = await collectUntrackedDiff(root);
    assert.equal(typeof out, "string");
  });

  it("respects .gitignore via --exclude-standard", async () => {
    const root = newRepo();
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.js\n");
    execFileSync("git", ["-C", root, "add", ".gitignore"], { encoding: "utf8" });
    execFileSync(
      "git",
      ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
       "commit", "--quiet", "-m", "add gitignore"],
      { encoding: "utf8" },
    );
    fs.writeFileSync(path.join(root, "ignored.js"), "should not appear\n");
    fs.writeFileSync(path.join(root, "visible.js"), "should appear\n");

    const out = await collectUntrackedDiff(root);
    assert.doesNotMatch(out, /ignored\.js/);
    assert.match(out, /visible\.js/);
  });
});

describe("collectUntrackedDiff — bounded resource usage (REQ-6)", () => {
  it("throws UNTRACKED_LIMIT_EXCEEDED when file count exceeds maxFiles", async () => {
    const root = newRepo();
    // Use a small custom limit so the test stays fast and deterministic.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), "x\n");
    }
    await assert.rejects(
      () => collectUntrackedDiff(root, { maxFiles: 5 }),
      (err) => {
        assert.equal(err.code, "UNTRACKED_LIMIT_EXCEEDED");
        assert.match(err.message, /\b6\b/);   // observed count
        assert.match(err.message, /\b5\b/);   // limit
        return true;
      },
    );
  });

  it("throws UNTRACKED_LIMIT_EXCEEDED when a single file exceeds maxFileSize", async () => {
    const root = newRepo();
    const big = Buffer.alloc(101, 65); // 101 'A' bytes
    fs.writeFileSync(path.join(root, "big.bin"), big);
    await assert.rejects(
      () => collectUntrackedDiff(root, { maxFiles: 10, maxFileSize: 100 }),
      (err) => {
        assert.equal(err.code, "UNTRACKED_LIMIT_EXCEEDED");
        assert.match(err.message, /big\.bin/);
        assert.match(err.message, /\b101\b/);  // observed bytes
        assert.match(err.message, /\b100\b/);  // limit
        return true;
      },
    );
  });

  it("does not throw when counts and sizes are within limits", async () => {
    const root = newRepo();
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, `ok${i}.txt`), "ok\n");
    }
    await assert.doesNotReject(() =>
      collectUntrackedDiff(root, { maxFiles: 5, maxFileSize: 100 }),
    );
  });
});

describe("collectUntrackedDiff — retained runtime artifacts", () => {
  it("excludes retained CLI runtime files before bounded Git capture and keeps every selected source diff", async () => {
    const root = newRepo();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "!/.tmp/\n!/.tmp/**\n!/.sennel/\n!/.sennel/**\n");
      execFileSync("git", ["-C", root, "add", ".gitignore"], { encoding: "utf8" });
      execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "--quiet", "-m", "Include retained diagnostics in the Git fixture"], { encoding: "utf8" });
      const noisePrefix = ".tmp/logs/archive/";
      const filename = (index) => "entry-" + String(index).padStart(5, "0") + "-history.log";
      const pathnameBytes = Buffer.byteLength(noisePrefix + filename(0) + "\0");
      const retainedDiagnosticCount = Math.floor((1024 * 1024) / pathnameBytes) + 1;
      assert.ok(retainedDiagnosticCount * pathnameBytes > 1024 * 1024,
        "the excluded pathname listing alone exceeds the original 1MiB capture cap");
      fs.mkdirSync(path.join(root, noisePrefix), { recursive: true });
      for (let index = 0; index < retainedDiagnosticCount; index += 1) {
        fs.writeFileSync(path.join(root, noisePrefix, filename(index)), "");
      }
      const sources = [
        ["src/retained file.js", "export const retained = true;\n"],
        [".sennel/process-runtime-notes.txt", "Ordinary source beside a runtime prefix remains visible.\n"],
        [".sennel/specs/802-scope/artifacts/tests/source/kept.test.js", "export const keepTestSource = true;\n"],
      ].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const runtimeArtifacts = new FlowRepositoryRuntimeArtifactRegistry();
      assert.equal(runtimeArtifacts.owns(noisePrefix + filename(0)), true);
      const expected = sources.map(([relative, body]) => {
        assert.equal(runtimeArtifacts.owns(relative), false);
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), body);
        const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", devNull, relative], {
          cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        assert.equal(result.status, 1);
        assert.equal(result.signal, null);
        return result.stdout;
      }).join("");
      const diff = await collectUntrackedDiff(root, { excludeFile: (relative) => runtimeArtifacts.owns(relative) });
      assert.equal(diff, expected);
    } catch (error) {
      testTemporaryRoot().retainOnUnconfirmedExecution();
      throw error;
    }
  });
});
