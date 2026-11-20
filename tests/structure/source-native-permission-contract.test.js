import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { SourceDeclaration, SourceModule } from "../support/structure/source-reader.js";
import { SourceNativePermissionContract } from "../support/structure/source-native-permission-contract.js";

const api = fs.readFileSync(new URL("../../src/lib/regular-file-snapshot.js", import.meta.url), "utf8");
const originalModule = new SourceModule("src/original-native-metadata.js", api);
const originalClass = originalModule.declaration("FilePermissionHint");
const last = originalClass.tokens.at(-1);
const classText = api.slice(originalClass.token.offset, last.offset + last.value.length);
const ordinary = `import fs from "node:fs";\n${classText}`;

// These supplied facts stand for the existing effect/origin engine. This
// isolated reader test never supplies an OS03 exemption or runtime proof.
class ContractFacts {
  constructor({ stable = true, unknown = null, filesystem = "fs.fchmodSync" } = {}) {
    this.stable = stable;
    this.unknown = unknown;
    this.filesystem = filesystem;
    this.observed = [];
  }
  stableClass(module, declaration) {
    assert.equal(module.declaration(declaration.name), declaration);
    return this.stable;
  }
  builtinCall(module, tokens, builtin, member) {
    assert.ok(tokens.every(token => module.tokens.includes(token)));
    const key = `${builtin}.${member ?? "<call>"}`;
    this.observed.push(key);
    if (key === this.unknown) return undefined;
    const spelling = tokens.map(token => token.value).join("");
    const expected = new Map([
      ["Number.isInteger", "Number.isInteger"], ["Object.freeze", "Object.freeze"],
      ["TypeError.<call>", "TypeError"], ["Number.<call>", "Number"],
      ["fs.fchmodSync", this.filesystem], ["process.platform", "process.platform"],
    ]);
    return spelling === expected.get(key);
  }
}

function inspect(source = ordinary, facts = new ContractFacts(), name = "FilePermissionHint") {
  const module = new SourceModule("src/renamed-native-metadata.js", source);
  return SourceNativePermissionContract.inspect(module, module.declaration(name), facts);
}

test("the actual native metadata class retains its exact lexical members", () => {
  const facts = new ContractFacts();
  const contract = inspect(ordinary, facts);
  assert.ok(contract instanceof SourceNativePermissionContract);
  assert.equal(contract.field, "mode");
  assert.equal(contract.apply.token.value, "applyToDescriptor");
  assert.equal(contract.capture.token.value, "fromStat");
  assert.equal(contract.equal.token.value, "matches");
  assert.equal(contract.afterWrite.token.value, "matchesAfterWrite");
  assert.equal(contract.declaration, contract.module.declaration("FilePermissionHint"));
  assert.ok(Object.isFrozen(contract));
  for (const member of [contract.initialize, contract.apply, contract.capture, contract.equal, contract.afterWrite]) {
    assert.ok(member instanceof SourceDeclaration);
    assert.ok(member.tokens.every(token => contract.module.tokens.includes(token)));
  }
  assert.deepEqual([...new Set(facts.observed)].sort(), ["Number.<call>", "Number.isInteger", "Object.freeze",
    "TypeError.<call>", "fs.fchmodSync", "process.platform"].sort());
  assert.equal(Object.hasOwn(contract, "safe"), false);
  assert.equal(Object.hasOwn(contract, "descriptor"), false, "class shape does not manufacture an application receipt");
});

test("class, scalar, parameter, method and module spellings do not grant the contract", () => {
  const renamed = ordinary.replaceAll("FilePermissionHint", "NativeMetadata")
    .replaceAll(/\bmode\b/g, "mask").replaceAll("stat.mask", "stat.mode")
    .replaceAll("fromStat", "capture").replaceAll("applyToDescriptor", "apply")
    .replaceAll("matchesAfterWrite", "sameAfterWrite").replaceAll("matches", "same")
    .replaceAll("descriptor", "handle").replaceAll(/\bother\b/g, "observed");
  const contract = inspect(renamed, new ContractFacts(), "NativeMetadata");
  assert.ok(contract instanceof SourceNativePermissionContract);
  assert.equal(contract.field, "mask");
  assert.equal(contract.afterWrite.token.value, "sameAfterWrite");
});

for (const [source, filesystem] of [
  [ordinary.replaceAll(/\bfs\b/g, "io").replace('"node:io"', '"node:fs"'), "io.fchmodSync"],
  [ordinary.replace('import fs from "node:fs";', 'import { fchmodSync as applyNative } from "node:fs";')
    .replace("fs.fchmodSync", "applyNative"), "applyNative"],
]) test(`resolved filesystem aliases preserve the source contract: ${filesystem}`, () => {
  assert.ok(inspect(source, new ContractFacts({ filesystem })) instanceof SourceNativePermissionContract);
});

for (const [label, changed] of [
  ["missing integer validation", ordinary.replace("Number.isInteger(mode)", "true")],
  ["different range", ordinary.replace("mode > 0o7777", "mode > 0o77777")],
  ["missing freeze", ordinary.replace("Object.freeze(this);", "")],
  ["different assigned hint", ordinary.replace("this.mode = mode;", "this.mode = 0;")],
  ["unmasked capture", ordinary.replace("Number(stat.mode) & 0o7777", "Number(stat.mode)")],
  ["wrong descriptor", ordinary.replace("fs.fchmodSync(descriptor, this.mode)", "fs.fchmodSync(9, this.mode)")],
  ["different applied hint", ordinary.replace("fs.fchmodSync(descriptor, this.mode)", "fs.fchmodSync(descriptor, 0o777)")],
  ["swallowed native error", ordinary.replace("fs.fchmodSync(descriptor, this.mode);", "try { fs.fchmodSync(descriptor, this.mode); } catch {}")],
  ["ownership mutation", ordinary.replace("fchmodSync", "fchownSync")],
  ["Windows full-mode equality", ordinary.replace("(this.mode & 0o200) === (other.mode & 0o200)", "this.mode === other.mode")],
  ["Windows always refusal", ordinary.replace("if (process.platform === \"win32\") return this.matches(other);", "if (process.platform === \"win32\") return false;")],
  ["missing Windows path", ordinary.replace("if (process.platform === \"win32\") return this.matches(other);", "")],
  ["accepting new setid bits", ordinary.replace("(other.mode & 0o6000 & ~this.mode) === 0", "true")],
  ["additional method", ordinary.replace(/}\s*$/, "extra() {} }")],
  ["empty field", ordinary.replace("constructor(mode)", "extra; constructor(mode)")],
  ["eager field", ordinary.replace("constructor(mode)", "extra = opaque(); constructor(mode)")],
  ["static block", ordinary.replace("constructor(mode)", "static { opaque(); } constructor(mode)")],
  ["computed method", ordinary.replace("matches(other)", '["matches"](other)')],
  ["duplicate member", ordinary.replace(/}\s*$/, "matches(other) { return true; } }")],
  ["async method", ordinary.replace("applyToDescriptor(descriptor)", "async applyToDescriptor(descriptor)")],
  ["generator method", ordinary.replace("applyToDescriptor(descriptor)", "*applyToDescriptor(descriptor)")],
  ["inheritance", ordinary.replace("class FilePermissionHint {", "class FilePermissionHint extends Parent {")],
  ["shadowed Number", `const Number = foreign; ${ordinary}`],
  ["shadowed Object", `const Object = foreign; ${ordinary}`],
  ["shadowed TypeError", `const TypeError = foreign; ${ordinary}`],
  ["shadowed process", `const process = foreign; ${ordinary}`],
]) test(`an unsupported metadata class remains unresolved: ${label}`, () => {
  assert.notEqual(changed, ordinary, "the negative must change its intended source input");
  assert.equal(inspect(changed), null);
  assert.ok(inspect() instanceof SourceNativePermissionContract, "restoring the class restores only its shape proof");
});

for (const unknown of ["Number.isInteger", "Object.freeze", "TypeError.<call>", "Number.<call>", "fs.fchmodSync", "process.platform"]) {
  test(`unknown intrinsic provenance cannot establish metadata shape: ${unknown}`, () => {
    assert.equal(inspect(ordinary, new ContractFacts({ unknown })), null);
  });
}
for (const stable of [false, undefined, null]) test(`unknown class effects cannot establish metadata shape: ${stable}`, () => {
  const facts = new ContractFacts();
  facts.stable = stable;
  assert.equal(inspect(ordinary, facts), null);
});

test("partial adapters and direct construction cannot mint a class proof", () => {
  assert.equal(inspect(ordinary, {}), null);
  assert.equal(inspect(ordinary, { stableClass() { return true; } }), null);
  assert.throws(() => new SourceNativePermissionContract(), TypeError);
});

test("a native prototype setter cannot establish the bounded own metadata field", () => {
  const changed = ordinary.replaceAll("this.mode", "this.__proto__").replaceAll("other.mode", "other.__proto__");
  assert.notEqual(changed, ordinary);
  assert.ok(changed.includes("Number(stat.mode)"), "the native Stat capture remains the same input");
  assert.equal(inspect(changed), null);
  assert.ok(inspect() instanceof SourceNativePermissionContract);
});

for (const field of ["applyToDescriptor", "matches", "matchesAfterWrite"]) {
  test(`an own scalar cannot shadow the metadata operation: ${field}`, () => {
    const changed = ordinary.replaceAll("this.mode", `this.${field}`).replaceAll("other.mode", `other.${field}`);
    assert.notEqual(changed, ordinary);
    assert.ok(changed.includes("Number(stat.mode)"));
    assert.equal(inspect(changed), null);
    assert.ok(inspect() instanceof SourceNativePermissionContract);
  });
}
