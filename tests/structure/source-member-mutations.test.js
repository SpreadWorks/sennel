import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceInitializer, SourceMemberAccess, readAssignmentTarget, readTokens } from "../support/structure/source-reader.js";
import { SourceMemberMutation, SourceMemberMutations } from "../support/structure/source-member-mutations.js";

function inspect(source) {
  const module = new SourceModule("member-writes.mjs", source, { lexicalOnly: true });
  return new SourceMemberMutations(module);
}

test("nested member writes retain exact target, operator and ancestor receiver identities", () => {
  const index = inspect("function change(input, value) {\n  input.entry.file = value;\n}");
  assert.equal(index.complete, true);
  assert.equal(index.entries.length, 1);
  const [write] = index.entries;
  assert.ok(write instanceof SourceMemberMutation);
  assert.ok(write.target instanceof SourceInitializer);
  assert.ok(write.member instanceof SourceMemberAccess);
  assert.equal(write.target.matches("input.entry.file"), true);
  assert.equal(write.member.name, "file");
  assert.equal(write.operator, "=");
  assert.deepEqual(write.receivers.map(receiver => receiver.tokens.map(token => token.value).join("")), ["input", "input.entry"]);
  assert.deepEqual(write.receiverTokens.map(token => token.value), ["input", "entry"]);
  assert.deepEqual([write.token.line, write.token.column], [2, 20]);
  for (const token of write.receiverTokens) assert.deepEqual(index.writesContaining(token), [write]);
  assert.deepEqual(index.writesContaining(write.member.token), []);
  assert.deepEqual(index.mutationFor(write.token), [write]);
  assert.equal(write.target.tokens.every(token => index.module.tokens.includes(token)), true);
});

for (const operator of ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]) {
  test(`member assignment reads the shared lvalue grammar for ${operator}`, () => {
    const index = inspect(`input.entry[other.key] ${operator} value;`);
    assert.equal(index.entries.length, 1);
    const [write] = index.entries;
    assert.equal(write.supported, true);
    assert.equal(write.operator, operator);
    assert.equal(write.target.matches("input.entry[other.key]"), true);
    assert.equal(write.member.name, null);
    assert.deepEqual(write.receiverTokens.map(token => token.value), ["input", "entry"]);
    for (const token of write.operatorTokens) assert.deepEqual(index.mutationFor(token), [write]);
    const equal = index.module.tokens.findIndex(token => token.value === "=");
    assert.deepEqual(readAssignmentTarget(index.module.tokens, equal).tokens, write.target.tokens);
  });
}

test("computed key reads and calls do not become mutated receivers", () => {
  const index = inspect("input[other.key].file = value; getHolder(arg).file = value; input.method(arg).file = value;");
  assert.equal(index.entries.length, 3);
  const [computed, call, method] = index.entries;
  assert.deepEqual(computed.receivers.map(receiver => receiver.tokens.map(token => token.value).join("")), ["input", "input[other.key]"]);
  assert.deepEqual(computed.receiverTokens.map(token => token.value), ["input"]);
  assert.deepEqual(call.receivers.map(receiver => receiver.tokens.map(token => token.value).join("")), ["getHolder(arg)"]);
  assert.deepEqual(method.receivers.map(receiver => receiver.tokens.map(token => token.value).join("")), ["input.method(arg)"]);
  assert.deepEqual(call.receiverTokens, []);
  assert.deepEqual(method.receiverTokens, []);
  for (const token of index.module.tokens.filter(token => ["other", "key", "getHolder", "arg", "method"].includes(token.value))) {
    assert.deepEqual(index.writesContaining(token), []);
  }
});

for (const source of ["++input.entry.file;", "input.entry.file++;", "--input.entry.file;", "input.entry.file--;", "delete input.entry.file;", "delete input?.entry?.[key];", "(input.entry).file += value;"]) {
  test(`member update keeps its syntactic receiver chain: ${source}`, () => {
    const index = inspect(source);
    assert.equal(index.complete, true);
    assert.equal(index.entries.length, 1);
    assert.deepEqual(index.entries[0].receiverTokens.map(token => token.value), ["input", "entry"]);
    assert.equal(index.entries[0].member.name, source.includes("[key]") ? null : "file");
  });
}

test("a new line starts a prefix update rather than consuming the previous expression", () => {
  const index = inspect("previous\n++input.file;");
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].target.matches("input.file"), true);
  assert.deepEqual(index.writesContaining(index.module.tokens[0]), []);
});

test("grouped lvalues and optional receivers preserve their full exact expression spans", () => {
  const index = inspect("(input.file) = value; (input.file)++; delete (input.file); (input?.entry).file = value; (getHolder?.(arg)).file = value;");
  assert.equal(index.complete, true);
  assert.deepEqual(index.entries.map(write => write.target.tokens.map(token => token.value).join("")),
    ["(input.file)", "(input.file)", "(input.file)", "(input?.entry).file", "(getHolder?.(arg)).file"]);
  const [assignment] = index.entries;
  const equal = index.module.tokens.findIndex(token => token === assignment.token);
  assert.deepEqual(readAssignmentTarget(index.module.tokens, equal).tokens, assignment.target.tokens);
  assert.deepEqual(index.entries[3].receiverTokens.map(token => token.value), ["input", "entry"]);
  assert.deepEqual(index.entries[4].receiverTokens, []);
});

test("destructuring indexes only property targets and attributes defaults to the outer operation", () => {
  const index = inspect("({ key: input.file = fallback, [other.key]: nested.entry.file, rest: [local, ...tail.file] } = source);");
  assert.equal(index.complete, true);
  assert.deepEqual(index.entries.map(write => write.target.tokens.map(token => token.value).join("")), ["input.file", "nested.entry.file", "tail.file"]);
  assert.equal(new Set(index.entries.map(write => write.token)).size, 1);
  assert.deepEqual(index.mutationFor(index.entries[0].token), index.entries);
  for (const token of index.module.tokens.filter(token => ["other", "key", "fallback", "local", "source"].includes(token.value))) {
    assert.deepEqual(index.writesContaining(token), []);
  }
});

test("iteration member targets remain explicit incomplete writes with exact loop tokens", () => {
  const index = inspect("for (input[other.key].file of values) {} for ({ key: nested.file } in source) {} for await (input.entry.file of stream) {}");
  assert.equal(index.complete, false);
  assert.deepEqual(index.entries.map(write => [write.operator, write.target.tokens.map(token => token.value).join(""), write.supported]),
    [["of", "input[other.key].file", false], ["in", "nested.file", false], ["of", "input.entry.file", false]]);
  for (const write of index.entries) {
    assert.equal(write.reason, "unsupported iteration member mutation");
    assert.deepEqual(index.mutationFor(write.token), [write]);
    for (const token of write.receiverTokens) assert.deepEqual(index.writesContaining(token), [write]);
  }
  for (const token of index.module.tokens.filter(token => ["other", "key", "values", "source", "stream"].includes(token.value))) {
    assert.deepEqual(index.writesContaining(token), []);
  }
});

test("ordinary iteration bindings and membership reads are not member writes", () => {
  const index = inspect("let item; for (item of values) {} for (const value of values) {} for (const [left, right] of pairs) {} for (let { key } of values) {} if (item in source) {} const present = item in source;");
  assert.equal(index.complete, true);
  assert.deepEqual(index.entries, []);
  const itemBinding = index.module.moduleBinding("item");
  const writes = index.module.bindingWrites([itemBinding]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].binding, itemBinding);
  assert.equal(writes[0].token, index.module.tokens.find((token, offset) => token.value === "item" && index.module.tokens[offset + 1]?.value === "of"));
});

test("shadowed receiver names retain exact lexical identities without name matching", () => {
  const index = inspect("const input = {}; function inner(input) { input.file = value; } input.file = other;");
  assert.equal(index.entries.length, 2);
  const [inner, outer] = index.entries;
  const first = inner.receiverTokens[0], second = outer.receiverTokens[0];
  assert.notEqual(index.module.bindingAt(first), index.module.bindingAt(second));
  assert.deepEqual(index.writesContaining(first), [inner]);
  assert.deepEqual(index.writesContaining(second), [outer]);
  assert.deepEqual(index.writesContaining(readTokens("input")[0]), []);
});

test("explicit construction receivers are indexed while tagged lvalues remain unresolved", () => {
  const index = inspect("new Holder(arg).file = value; tag`plain`.file = value; delete new Holder(arg).file;");
  assert.equal(index.complete, false);
  assert.equal(index.entries.length, 3);
  assert.deepEqual(index.entries.map(entry => entry.supported), [true, false, true]);
  assert.equal(index.entries[0].reason, null);
  assert.equal(index.entries[2].reason, null);
  assert.equal(typeof index.entries[1].reason, "string");
  assert.ok(index.entries[1].reason.length > 0);
  assert.equal(index.entries[0].receivers.at(-1).matches("new Holder(arg)"), true);
  assert.equal(index.entries[2].receivers.at(-1).matches("new Holder(arg)"), true);
  assert.deepEqual(index.entries[0].receiverTokens, []);
  assert.equal(index.entries[0].target.matches("new Holder(arg).file"), true);
  assert.equal(index.entries[2].target.matches("new Holder(arg).file"), true);
});

test("binding writes, property reads, comparisons, arrows and inert text are not member mutations", () => {
  const index = inspect('let local = value; local += value; local++; ++local; delete local; input.file === value; input.file <= value; input.file >= value; input.file !== value; const fn = () => input.file; const text = "input.file = value"; class Holder { static file = value; delete = value; } const options = { delete: input.file };');
  assert.deepEqual(index.entries, []);
});

test("shared assignment target rejects comparisons and separated compound punctuation", () => {
  for (const source of ["input.file <= value", "input.file >= value", "input.file == value", "input.file === value", "input.file != value", "input.file + = value", "input.file < <= value", "input.file > >= value", "input.file = > value"]) {
    const tokens = readTokens(source);
    for (const [index, token] of tokens.entries()) if (token.value === "=") assert.equal(readAssignmentTarget(tokens, index), null, source);
  }
  assert.equal(readTokens("input => input.file").some(token => token.value === "="), false);
  for (const source of ["input.file<<=value", "input.file >>= value", "input.file\n>>>=\nvalue"]) {
    const tokens = readTokens(source);
    const equal = tokens.findIndex(token => token.value === "=");
    assert.equal(readAssignmentTarget(tokens, equal)?.matches("input.file"), true, source);
  }
});

test("mutation index constructors enforce source identities", () => {
  assert.throws(() => new SourceMemberMutations({ tokens: [] }), TypeError);
  const index = inspect("input.file = value;");
  const [write] = index.entries;
  assert.throws(() => new SourceMemberMutation(index.module, readTokens("="), "=", write.target, write.receivers, write.receiverTokens, write.member), TypeError);
  assert.throws(() => new SourceMemberMutation(index.module, write.operatorTokens, "=", write.target, write.receivers, write.receiverTokens, null), TypeError);
  assert.throws(() => new SourceMemberMutation(index.module, write.operatorTokens, "+=", write.target, write.receivers, write.receiverTokens, write.member), TypeError);
});

test("constructed callee namespaces and arguments remain reads, not mutated ancestors", () => {
  const index = inspect("new factory.Holder(input).entry.file = value; new Holder.file = value;");
  assert.equal(index.entries[0].supported, true);
  assert.equal(index.entries[0].receivers[0].matches("new factory.Holder(input)"), true);
  assert.equal(index.entries[0].receivers[1].matches("new factory.Holder(input).entry"), true);
  assert.deepEqual(index.entries[0].receiverTokens.map(token => token.value), ["entry"]);
  assert.equal(index.entries[1].supported, false);
  assert.deepEqual(index.startingAt(index.entries[0].target.token), [index.entries[0]]);
});
