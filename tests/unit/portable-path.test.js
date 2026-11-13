import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { LogicalRelativePath, LogicalPathSet, PortablePathError, isNativePathWithin, isNativePathSpellingWithin } from "../../src/lib/portable-path.js";
import { NativeAbsolutePath } from "../../src/lib/native-path.js";
import { maskSensitive } from "../../src/lib/log-masking.js";

test("logical names preserve spaces, binary-file suffixes and Unicode spelling", () => {
  const value = new LogicalRelativePath("資料/space name/e\u0301.bin");
  assert.equal(String(value), "資料/space name/e\u0301.bin");
  assert.deepEqual(value.segments, ["資料", "space name", "e\u0301.bin"]);
  assert.equal(LogicalRelativePath.from(value), value);
});

test("logical grammar rejects names that cannot have the same meaning on all hosts", () => {
  const values = ["", "/tmp/a", "C:/a", "C:a", "\\\\server\\share", "//server/share", "a\\b", "a/../b", "a/./b", "a//b", "a/", "a\0b", "a\u001fb", "a:b", "a?b", "a*b", "a|b", "a<b", 'a"b', "a>", "a.", "a ", "aux", "NUL.txt", "COM¹.log", "lpt²", "COM9", "CONOUT$", "bad\uD800"];
  for (const value of values) {
    assert.throws(() => new LogicalRelativePath(value), (error) => error instanceof PortablePathError && error.code === "PORTABLE_PATH_INVALID", JSON.stringify(value));
  }
  assert.equal(String(new LogicalRelativePath("COM0/file..name")), "COM0/file..name");
});

test("complete logical target sets reject aliases and file-prefix conflicts in either order", () => {
  for (const values of [["file", "FILE"], ["é.json", "e\u0301.json"], ["Dir/a", "dir/b"], ["a", "a/b"], ["a/b", "a"], ["a", "a"]]) {
    assert.throws(() => new LogicalPathSet(values), { code: "PORTABLE_PATH_COLLISION" });
  }
  assert.deepEqual(new LogicalPathSet(["a", "a/b"], { allowDirectoryPrefixes: true }).toStrings(), ["a", "a/b"]);
  assert.throws(() => new LogicalPathSet(["a", "A/b"], { allowDirectoryPrefixes: true }), { code: "PORTABLE_PATH_COLLISION" });
  assert.deepEqual(new LogicalPathSet(["ab", "a/b"]).toStrings(), ["ab", "a/b"]);
});

test("native values require host absolute names and containment respects segments", () => {
  assert.throws(() => new NativeAbsolutePath("relative/name"), { code: "PORTABLE_PATH_INVALID" });
  const root = path.resolve("path-root");
  assert.equal(String(new NativeAbsolutePath(root)), root);
  assert.equal(isNativePathWithin(root, path.join(root, "file")), true);
  assert.equal(isNativePathWithin(root, `${root}-neighbor`), false);
  assert.equal(isNativePathWithin(root, path.join(root, "..", "outside")), false);
});

test("log spelling containment covers drive and UNC aliases without trusting adjacent roots", () => {
  const cases = [
    ["C:\\Work Root", "c:/work root/資料/file", true],
    ["C:\\Work", "C:\\Work-other\\secret", false],
    ["C:\\Work", "C:\\Work\\..\\secret", false],
    ["C:\\Work", "D:\\Work\\secret", false],
    ["\\\\Server\\Share\\Work", "//server/share/work/file", true],
    ["\\\\Server\\Share", "\\\\Server\\Share-other\\file", false],
    ["/work", "/work/file", true], ["/work", "/Work/file", false],
  ];
  for (const [root, target, expected] of cases) assert.equal(isNativePathSpellingWithin(root, target), expected, `${root} / ${target}`);
});

test("masking preserves trusted spellings while hiding sibling, traversal and UNC paths", () => {
  const roots = ["/portable-root", "C:\\Work Root", "\\\\Server\\Share\\Work"];
  const opts = { trustedRoots: roots };
  for (const candidate of ["/portable-root/file", "c:/work root/資料/file", "//server/share/work/file"]) assert.equal(maskSensitive(candidate, opts), candidate);
  for (const candidate of ["/portable-root-neighbor/secret", "C:\\Work Root-other\\secret", "C:\\Work Root\\..\\secret", "\\\\Server\\Other\\secret"]) assert.equal(maskSensitive(candidate, opts), "***");
  assert.equal(maskSensitive('file="C:\\Private Name\\secret"', opts), 'file="***"');
  const token = ["gh", "p_"].join("") + "a".repeat(36);
  assert.equal(maskSensitive(`C:\\Work Root\\${token}`, opts).includes(token), false);
});

const maskingRoots = ["/trusted", "C:\\Work Root", "\\\\Server\\Share\\Work"];
for (const [label, input, expected] of [
  ["a diagnostic suffix", "/trusted/a: open(/private/secret)", "/trusted/a: open(***)"],
  ["punctuation without whitespace", "/trusted/a:open(/private/secret)", "/trusted/a:open(***)"],
  ["a colon-separated path", "files=/trusted/a:/private/secret", "files=/trusted/a:***"],
  ["an embedded assignment path", "files=/trusted/a=/private/secret", "files=/trusted/a=***"],
  ["an embedded address path", "/trusted/a@/private/secret", "/trusted/a@***"],
  ["an external-first embedded address path", "/private/secret@/trusted/a", "***@/trusted/a"],
  ["trusted then external prose paths", "open(/trusted/a),read(/private/secret)", "open(/trusted/a),read(***)"],
  ["external then trusted prose paths", "open(/private/secret),read(/trusted/a)", "open(***),read(/trusted/a)"],
  ["trusted then external quoted paths", 'files="/trusted/a /private/secret"', 'files="/trusted/a ***"'],
  ["external then trusted quoted paths", 'files="/private/secret /trusted/a"', 'files="*** /trusted/a"'],
  ["a quoted diagnostic suffix", 'file="/trusted/a:open(/private/secret)"', 'file="/trusted/a:open(***)"'],
  ["quoted external spaces", 'files="/trusted/a D:/Private Name/secret"', 'files="/trusted/a ***"'],
  ["drive roots and separators", "c:/work root/a:open(D:\\Private\\secret)", "c:/work root/a:open(***)"],
  ["UNC roots and separators", "//server/share/work/a,\\\\Private\\Share\\secret", "//server/share/work/a,***"],
]) {
  test(`masking isolates ${label} from a trusted native reference`, () => {
    assert.equal(maskSensitive(input, { trustedRoots: maskingRoots }), expected);
  });
}

test("masking preserves single path values with spaces and punctuation, URLs and relative names", () => {
  for (const value of [
    "/trusted/a file (copy).txt", 'file="/trusted/a file (copy).txt"',
    "c:/work root/a file.txt", 'file="c:/work root/a file.txt"',
    "//server/share/work/a file.txt", "relative/path.txt", "../relative/path.txt", "~/relative/path", "資料/file.txt",
    "https://example.test/a(b)/c?next=/relative/path", "open(/trusted/a); read relative/file.txt",
  ]) assert.equal(maskSensitive(value, { trustedRoots: maskingRoots }), value, value);
  assert.equal(maskSensitive("/private/a file.txt", { trustedRoots: maskingRoots }), "***");
  assert.equal(maskSensitive('file="D:\\Private Name\\a file.txt"', { trustedRoots: maskingRoots }), 'file="***"');
});

test("masking removes secrets before preserving independent trusted and URL references", () => {
  const token = ["gh", "p_"].join("") + "a".repeat(36);
  const input = `/trusted/${token}:open(/private/secret) https://user:password@example.test/a relative/path`;
  assert.equal(maskSensitive(input, { trustedRoots: maskingRoots }),
    "/trusted/***:open(***) https://***@example.test/a relative/path");
});

test("masking root and drive prefixes preserve ordinary text and drive-relative paths", () => {
  for (const value of ["ordinary text", "relative/path", "C:relative/file"]) {
    assert.equal(maskSensitive(value, { trustedRoots: ["/", "C:\\"] }), value);
  }
  const value = "file=/trusted (data)/a.txt";
  assert.equal(maskSensitive(value, { trustedRoots: ["/trusted (data)"] }), value);
});


test("portable spelling lookup preserves retained names and implicit ancestor spelling", () => {
  const paths = new LogicalPathSet(["Café/é.bin", "Café/other"]);
  assert.equal(paths.spellingFor("CAFE\u0301"), "Café");
  assert.equal(paths.spellingFor("cafe\u0301/e\u0301.BIN"), "Café/é.bin");
  assert.equal(paths.spellingFor("Café/missing"), null);
  assert.throws(() => paths.spellingFor("Café/../escape"), { code: "PORTABLE_PATH_INVALID" });
  assert.throws(() => new LogicalPathSet(["Café/é.bin", "Cafe\u0301/other"]), { code: "PORTABLE_PATH_COLLISION" });
});
