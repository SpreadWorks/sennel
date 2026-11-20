import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceDeclaration, SourceObjectAccessor, SourceObjectMembers, SourceInitializer, SourceObjectSpread, readTokens, readParameters } from "../support/structure/source-reader.js";

test("named object getter and setter bodies remain separate exact declarations", () => {
  const module = new SourceModule("accessors.mjs", 'const holder = { get file() { return input.file; }, set file(value) { input.file = value; }, get "named"() { return source; } };', { lexicalOnly: true });
  const members = new SourceObjectMembers(module.tokens);
  assert.equal(members.complete, false);
  assert.deepEqual(members.entries, []);
  assert.deepEqual(members.unresolvedEntries, []);
  assert.deepEqual(members.accessors.map(accessor => [accessor.name, accessor.kind]), [["file", "get"], ["file", "set"], ["named", "get"]]);
  for (const accessor of members.accessors) {
    assert.ok(accessor instanceof SourceObjectAccessor);
    assert.ok(accessor instanceof SourceDeclaration);
    assert.equal(accessor.tokens.every(token => module.tokens.includes(token)), true);
  }
  assert.deepEqual(readParameters(members.accessors[1].tokens).map(part => part.map(token => token.value)), [["value"]]);
  assert.deepEqual(members.accessors[0].returns()[0].tokens.map(token => token.value), ["input", ".", "file"]);
  assert.deepEqual([members.accessors[1].token.line, members.accessors[1].token.column], [1, 53]);
});

test("accessor indexing preserves data and spread completeness contracts", () => {
  const plain = new SourceObjectMembers(readTokens("{ file: value, ...rest }"));
  assert.equal(plain.complete, true);
  assert.equal(plain.entries.length, 2);
  assert.ok(plain.entries[0] instanceof SourceInitializer);
  assert.ok(plain.entries[1] instanceof SourceObjectSpread);
  assert.deepEqual(plain.accessors, []);
  assert.deepEqual(plain.unresolvedEntries, []);
  const mixed = new SourceObjectMembers(readTokens("{ get file() { return value; }, field: value, ...rest }"));
  assert.equal(mixed.complete, false);
  assert.deepEqual(mixed.entries.map(entry => entry.token.value), ["field", "."]);
  assert.equal(mixed.accessors.length, 1);
  assert.deepEqual(mixed.unresolvedEntries, []);
});

test("readable accessors do not hide computed members in the same object", () => {
  const tokens = readTokens("{ get file() { return input.file; }, [readKey()]: value, get [key]() { return other; } }");
  const members = new SourceObjectMembers(tokens);
  assert.equal(members.complete, false);
  assert.deepEqual(members.accessors.map(accessor => [accessor.name, accessor.kind]), [["file", "get"]]);
  assert.deepEqual(members.entries, []);
  assert.deepEqual(members.unresolvedEntries.map(entry => entry.tokens.map(token => token.value).join("")),
    ["[readKey()]:value", "get[key](){returnother;}"]);
  for (const entry of members.unresolvedEntries) {
    assert.ok(entry instanceof SourceInitializer);
    assert.equal(tokens[entry.index], entry.token);
    assert.deepEqual(tokens.slice(entry.index, entry.index + entry.tokens.length), entry.tokens);
  }
});

test("unreadable property slots retain prototypes, duplicates, and malformed accessors", () => {
  const tokens = readTokens("{ __proto__: parent, file: first, file: second, get malformed(value) {}, set malformed() {} }");
  const members = new SourceObjectMembers(tokens);
  assert.equal(members.complete, false);
  assert.deepEqual(members.entries, []);
  assert.deepEqual(members.accessors, []);
  assert.deepEqual(members.unresolvedEntries.map(entry => entry.tokens.map(token => token.value).join("")),
    ["__proto__:parent", "file:first", "file:second", "getmalformed(value){}", "setmalformed(){}"]);
});

test("computed and unknown accessors remain opaque rather than acquiring named identities", () => {
  const members = new SourceObjectMembers(readTokens("{ get [key]() { return value; }, set [key](value) {}, get malformed(value) {}, set malformed() {} }"));
  assert.equal(members.complete, false);
  assert.deepEqual(members.accessors, []);
  assert.deepEqual(members.entries, []);
});

test("accessor constructors reject nonaccessor kinds and invalid parameter counts", () => {
  assert.throws(() => new SourceObjectAccessor("file", readTokens("get file() {}"), "method"), TypeError);
  assert.throws(() => new SourceObjectAccessor("file", readTokens("get file(value) {}"), "get"), TypeError);
  assert.throws(() => new SourceObjectAccessor("file", readTokens("set file() {}"), "set"), TypeError);
});
