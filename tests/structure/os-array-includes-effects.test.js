import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/includes-case.mjs";
function inspect(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}

// Ordinary native membership returns an unknown-truth boolean; source inputs
// are inspected as text and never executed by these tests.
const positives = [
  ["literal-known", "import fs from \"node:fs\";\n/* @target */ const result=['pipe','ignore'].includes('pipe'); opaque(result);\n"],
  ["literal-miss", "import fs from \"node:fs\";\n/* @target */ const result=['pipe','ignore'].includes('absent'); opaque(result);\n"],
  ["nan-search", "import fs from \"node:fs\";\n/* @target */ const result=[NaN].includes(NaN); opaque(result);\n"],
  ["signed-zero", "import fs from \"node:fs\";\n/* @target */ const result=[0].includes(-0); opaque(result);\n"],
  ["no-search", "import fs from \"node:fs\";\n/* @target */ const result=[undefined].includes(); opaque(result);\n"],
  ["negative-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe',-1); opaque(result);\n"],
  ["fractional-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe',0.4); opaque(result);\n"],
  ["nan-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe',NaN); opaque(result);\n"],
  ["infinite-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe',Infinity); opaque(result);\n"],
  ["string-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe','0'); opaque(result);\n"],
  ["null-index", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].includes('pipe',null); opaque(result);\n"],
  ["closed-map", "import fs from \"node:fs\";\n/* @target */ const result=['pipe'].map(String).includes('pipe'); opaque(result);\n"],
  ["unknown-search", "import fs from \"node:fs\";\nfunction accepts(value) { /* @target */ return ['pipe','ignore'].includes(value); }\nopaque(accepts(supplied));\n"],
  ["closed-alias", "import fs from \"node:fs\";\nconst first=['pipe','ignore']; const values=first;\n/* @target */ opaque(values.includes(supplied));\n"],
  ["search-is-noncoercive", "import fs from \"node:fs\";\nconst needle={valueOf(){return 3;},toString(){return 'pipe';}};\n/* @target */ opaque(['pipe'].includes(needle));\n"],
  ["sensitive-search-not-invoked", "import fs from \"node:fs\";\nconst needle=fs.readFileSync;\n/* @target */ opaque([needle].includes(needle));\n"],
  ["frozen-closed-array", "import fs from \"node:fs\";\nconst values=Object.freeze(['pipe']);\n/* @target */ opaque(values.includes('pipe'));\n"],
  ["pure-extra-argument", "import fs from \"node:fs\";\n/* @target */ opaque(['pipe'].includes('pipe',0,'unused'));\n"],
  ["native-nan-global", "import fs from \"node:fs\";\n/* @target */ opaque(['pipe'].includes('pipe',NaN));\n"],
  ["native-infinity-global", "import fs from \"node:fs\";\n/* @target */ opaque(['pipe'].includes('pipe',Infinity));\n"],
  ["signedzero-index", "import fs from \"node:fs\";\n/* @target */ opaque(['pipe'].includes('pipe',-0));\n"],
  ["primitive-arithmetic-index", "import fs from \"node:fs\";\n/* @target */ opaque(['pipe'].includes('pipe',4/2));\n"],
  ["local-nan-shadow", "import fs from \"node:fs\";\n/* @target */ const NaN='0';opaque(['pipe'].includes('pipe',NaN));\n"],
  ["local-infinity-shadow", "import fs from \"node:fs\";\n/* @target */ const Infinity=0;opaque(['pipe'].includes('pipe',Infinity));\n"],
];
for (const [name, source] of positives) {
  test(`native array includes keeps a closed noncoercing source boundary: ${name}`, () => {
    const report = inspect(source);
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
    assert.equal(report.complete, true);
  });
}

// Each refusal requires its own rule and source line, rather than a failure
// elsewhere in the source. Restoring the normal input must restore PASS.
const normal = positives[0][1];
const refusals = [
  ["unknown-fromindex", "import fs from \"node:fs\";\n/* @target */ ['pipe'].includes('pipe',supplied);\n", ["OS02"], 2],
  ["object-fromindex", "import fs from \"node:fs\";\nconst index={valueOf(){return 0;}};\n/* @target */ ['pipe'].includes('pipe',index);\n", ["OS02"], 3],
  ["fromindex-valueof-io", "import fs from \"node:fs\";\nconst index={valueOf(){ /* @io */ fs.readFileSync('/proc/self/stat'); return 0;}};\n/* @target */ ['pipe'].includes('pipe',index);\n", ["OS01"], 2],
  ["extra-argument-io", "import fs from \"node:fs\";\n/* @io */ ['pipe'].includes('pipe',0,fs.readFileSync('/proc/self/stat'));\n", ["OS01"], 2],
  ["element-getter-io", "import fs from \"node:fs\";\nconst values=['pipe'];\nObject.defineProperty(values,'0',{get(){ /* @io */ return fs.readFileSync('/proc/self/stat'); }});\n/* @target */ values.includes('pipe');\n", ["OS01"], 3],
  ["native-mutation", "import fs from \"node:fs\";\nconst values=['pipe'];\n/* @mutation */ Array.prototype.includes=foreign;\n/* @target */ values.includes('pipe');\n", ["OS02"], 4],
  ["own-mutation", "import fs from \"node:fs\";\nconst values=['pipe'];\n/* @mutation */ values.includes=foreign;\n/* @target */ values.includes('pipe');\n", ["OS02"], 4],
  ["prototype-mutation", "import fs from \"node:fs\";\nconst values=['pipe'];\n/* @mutation */ Object.setPrototypeOf(values,foreign);\n/* @target */ values.includes('pipe');\n", ["OS02"], 4],
  ["opaque-owner", "import fs from \"node:fs\";\nconst values=['pipe'];\n/* @mutation */ opaque(values);\n/* @target */ values.includes('pipe');\n", ["OS02"], 4],
  ["opaque-prototype", "import fs from \"node:fs\";\nconst values=['pipe'];\n/* @mutation */ opaque(Array.prototype);\n/* @target */ values.includes('pipe');\n", ["OS02"], 4],
  ["detached-receiver", "import fs from \"node:fs\";\nconst values=['pipe']; const method=values.includes;\n/* @target */ method('pipe');\n", ["OS02"], 3],
  ["fake-receiver", "import fs from \"node:fs\";\nconst values={includes:foreign};\n/* @target */ values.includes(fs.readFileSync);\n", ["OS01", "OS02"], 3],
  ["sparse-array", "import fs from \"node:fs\";\n/* @target */ [,].includes(undefined);\n", ["OS02"], 2],
  ["shadowed-native-with-real-io", "import fs from \"node:fs\";\nconst Array={prototype:{includes(values){ /* @io */ return fs.readFileSync(values[0]); }}};\nArray.prototype.includes(['/proc/self/stat']);\n", ["OS01"], 2],
  ["bigint-literal-fromindex", "import fs from \"node:fs\";\n/* @target */ ['pipe'].includes('pipe',1n);\n", ["OS02"], 2],
  ["bigint-converted-fromindex", "import fs from \"node:fs\";\n/* @target */ ['pipe'].includes('pipe',BigInt(1));\n", ["OS02"], 2],
  ["symbol-fromindex", "import fs from \"node:fs\";\n/* @target */ ['pipe'].includes('pipe',Symbol('index'));\n", ["OS02"], 2],
  ["method-getter-io", "import fs from \"node:fs\";\nconst values=['pipe'];\nObject.defineProperty(values,'includes',{get(){ /* @io */ return fs.readFileSync('/proc/self/stat'); }});\nvalues.includes('pipe');\n", ["OS01"], 3],
  ["weakset-bigint", "import fs from \"node:fs\";\n/* @target */ new WeakSet().add(1n);\n", ["OS02"], 2],
  ["weakmap-bigint", "import fs from \"node:fs\";\n/* @target */ new WeakMap().set(1n,{});\n", ["OS02"], 2],
  ["weakset-bigint-alias", "import fs from \"node:fs\";\n/* @target */ const key=1n;new WeakSet().add(key);\n", ["OS02"], 2],
  ["weakmap-bigint-alias", "import fs from \"node:fs\";\n/* @target */ const key=1n;new WeakMap().set(key,{});\n", ["OS02"], 2],
  ["weakset-bigint-default", "import fs from \"node:fs\";\n/* @target */ function write(key=1n){new WeakSet().add(key);}write();\n", ["OS02"], 2],
  ["weakmap-bigint-default", "import fs from \"node:fs\";\n/* @target */ function write(key=1n){new WeakMap().set(key,{});}write();\n", ["OS02"], 2],
  ["weakset-bigint-conditional", "import fs from \"node:fs\";\n/* @target */ const key=flag?1n:2n;new WeakSet().add(key);\n", ["OS02"], 2],
  ["weakmap-bigint-conditional", "import fs from \"node:fs\";\n/* @target */ const key=flag?1n:2n;new WeakMap().set(key,{});\n", ["OS02"], 2],
];
for (const [name, source, rules, line] of refusals) {
  test(`native array includes preserves the targeted refusal and restores: ${name}`, () => {
    assert.notEqual(source, normal);
    const report = inspect(source);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some(entry => entry.file === file && entry.line === line && rules.includes(entry.rule)),
      report.diagnostics.join("\n"));
    const restored = inspect(normal);
    assert.equal(restored.ok, true, restored.diagnostics.join("\n"));
    assert.deepEqual(restored.diagnostics, []);
  });
}
