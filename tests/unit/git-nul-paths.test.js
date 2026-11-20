import assert from "node:assert/strict";
import { test } from "node:test";
import { GitNulFields, GitPathChange, GitPorcelainV1Status, GitNameStatusChanges,
  GitNameStatusDecoder, GitStatusPathSet } from "../../src/lib/git-helpers.js";

test("V1 NUL status retains raw filenames and rename or copy roles without quoting", () => {
  const raw = ' 資料\tline\n"back\\slash.txt ';
  const input = Buffer.from(`?? ${raw}\0R  destination 資料.txt\0original 資料.txt\0C  copied.txt\0copy-source.txt\0`);
  const status = GitPorcelainV1Status.from(input);
  assert.equal(status.entries.every((entry) => entry instanceof GitPathChange), true);
  assert.deepEqual(status.entries.map((entry) => entry.toJSON()), [
    { status: "untracked", path: raw },
    { status: "renamed", path: "destination 資料.txt", old_path: "original 資料.txt" },
    { status: "modified", path: "copied.txt" },
  ]);
  assert.equal(status.entries[2].originalPath, "copy-source.txt");
  assert.deepEqual(GitStatusPathSet.fromPorcelainV1Z(input).toArray(),
    [raw, "destination 資料.txt", "original 資料.txt", "copied.txt", "copy-source.txt"]);
});

test("name-status buffered and split-field readers preserve roles and logical record bounds", () => {
  const input = Buffer.from("R100\0old 資料.txt\0new 資料.txt\0C075\0source.txt\0copied.txt\0M\0 leading\tline\n.txt \0");
  const buffered = GitNameStatusChanges.from(input);
  const decoder = new GitNameStatusDecoder();
  const observed = [];
  for (const field of new GitNulFields(input).values) {
    const entry = decoder.accept(field);
    if (entry !== null) observed.push(entry);
  }
  decoder.finish();
  const expected = [
    { status: "renamed", path: "new 資料.txt", old_path: "old 資料.txt" },
    { status: "modified", path: "copied.txt" },
    { status: "modified", path: " leading\tline\n.txt " },
  ];
  assert.deepEqual(buffered.entries.map((entry) => entry.toJSON()), expected);
  assert.deepEqual(observed.map((entry) => entry.toJSON()), expected);
  assert.equal(observed[1].originalPath, "source.txt");
  assert.equal(GitNameStatusChanges.from("R100\0old\0new\0", { maxEntries: 1 }).entries.length, 1);
  assert.equal(GitPorcelainV1Status.from("R  new\0old\0", { maxEntries: 1 }).entries.length, 1);
  assert.throws(() => GitNameStatusChanges.from(input, { maxEntries: 2 }), /returned 3 entries/);
  assert.throws(() => GitPorcelainV1Status.from("?? one\0?? two\0", { maxEntries: 1 }), /returned 2 entries/);
});

test("Git NUL boundaries reject invalid V1 XY, UTF-8 and incomplete records", () => {
  for (const xy of ["ZZ", "  ", ".M", "?M", "M?", "U ", " m"]) {
    const input = `${xy} file\0`;
    assert.throws(() => GitPorcelainV1Status.from(input), /status is invalid/);
  }
  for (const xy of [" M", "M ", "A ", "AD", "D ", "DD", "AU", "UD", "UA", "DU", "AA", "UU", "??", "!!"]) {
    assert.equal(GitPorcelainV1Status.from(`${xy} file\0`).entries.length, 1);
  }
  assert.equal(GitPorcelainV1Status.from("RD destination\0original\0").entries[0].path, "destination");
  for (const input of ["?? file", "R  destination\0", "\0"]) {
    assert.throws(() => GitPorcelainV1Status.from(input));
  }
  assert.throws(() => GitPorcelainV1Status.from(Buffer.from([63, 63, 32, 255, 0])), /not valid UTF-8/);
  for (const input of ["Z\0file\0", "R101\0old\0new\0", "A1\0file\0", "R100\0old\0", "M\0"]) {
    assert.throws(() => GitNameStatusChanges.from(input));
  }
});
