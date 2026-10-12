import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImports } from "../../../src/docs/lib/lang/js.js";
import { getLangHandler } from "../../../src/docs/lib/lang-factory.js";

test("static imports with combined bindings and attributes retain every occurrence", () => {
  const content = `
    import "./setup.js";
    import defaultBinding, { named as renamed } from "./combined.js";
    import anotherDefault, * as namespace from "./namespace.js";
    import data from "./data.json" with { type: "json" };
    import "./setup.js";
  `;
  assert.deepEqual(extractImports(content), [
    "./setup.js", "./combined.js", "./namespace.js", "./data.json", "./setup.js",
  ]);
});

test("non-static dependencies deduplicate against all static occurrences and each other", () => {
  const content = `
    const beforeStatic = import("./shared.js");
    export { named } from "./shared.js";
    import shared from "./shared.js";
    import "./shared.js";
    const common = require("./shared.js");
    const commonOnly = require("./common.cjs");
    const dynamicCommon = import("./common.cjs");
    const dynamicOnly = import("./dynamic.js");
    export * from "./dynamic.js";
    export * from "./re-export.js";
    export { renamed } from "./re-export.js";
  `;
  assert.deepEqual(extractImports(content), [
    "./shared.js", "./shared.js", "./common.cjs", "./dynamic.js", "./re-export.js",
  ]);
});

test("CommonJS module.require retains its existing literal dependency behavior", () => {
  const content = `
    const native = module.require("./native.cjs");
    const spaced = module . require("./spaced.cjs");
    const repeated = require("./native.cjs");
  `;
  assert.deepEqual(extractImports(content), ["./native.cjs", "./spaced.cjs"]);
});

test("literal dynamic dependencies are independent of how import options are supplied", () => {
  const content = `
    import("./configured.json", options);
    import("./created.json", makeOptions());
    import("./configured.json", { with: { type: "json" } });
  `;
  assert.deepEqual(extractImports(content), ["./configured.json", "./created.json"]);
});

test("literal dynamic import separated by a comment remains a dependency", () => {
  assert.deepEqual(extractImports('void import/* gap */("./dep.js");'), ["./dep.js"]);
});

test("ordinary import method after a member-access comment is excluded", () => {
  const content = 'const object = { import: () => {} }; object. /* gap */ import("./method.js");';
  assert.deepEqual(extractImports(content), []);
});

test("a dot inside a line comment before block trivia cannot suppress a dynamic import", () => {
  const content = '// description.\n/* detail */\nimport("./dep.js");';
  assert.deepEqual(extractImports(content), ["./dep.js"]);
});

test("a dot inside a block comment before a nested opener cannot suppress a dynamic import", () => {
  const content = '/* explanation . /* example */ import("./dep.js");';
  assert.deepEqual(extractImports(content), ["./dep.js"]);
});

test("member-access classification preserves quoted comment markers before calls", () => {
  const content = String.raw`
    const url = "https://example.invalid";
    const marker = '/* comment marker with an escaped quote: \' */';
    import/* call */("./dep.js");
    object./* member */import("./method.js");
    const sameLine = "// marker"; import("./same-line.js"); object. /* member */ import("./other-method.js");
  `;
  assert.deepEqual(extractImports(content), ["./dep.js", "./same-line.js"]);
});

test("comment markers in templates and regular expressions do not hide import methods", () => {
  const expressions = [
    'const text = `// marker`; object. /* member */ import("./method.js");',
    'const text = `${object. /* member */ import("./method.js")}`;',
    'const regex = /[//]/; object. /* member */ import("./method.js");',
    String.raw`const regex = /https?:\/\//; object. /* member */ import("./method.js");`,
    'if (condition) /[//]/.test(value); object. /* member */ import("./method.js");',
    'function check() {} /[//]/.test(value); object. /* member */ import("./method.js");',
    'const result = left / object. /* member */ import("./method.js") / right;',
    'const result = object.if(condition) / object. /* member */ import("./method.js") / right;',
  ];
  for (const expression of expressions) {
    assert.deepEqual(extractImports(expression), [], expression);
  }
});

test("template interpolations retain actual dynamic imports after commented dots", () => {
  const content = 'const text = `${ // description.\n /* detail */\n import("./dep.js")}`;';
  assert.deepEqual(extractImports(content), ["./dep.js"]);
});

test("re-export separated by a comment remains a dependency", () => {
  assert.deepEqual(extractImports('export /* gap */ { value } from "./dep.js";'), ["./dep.js"]);
});

test("dynamic import trivia preserves literal specifiers and import options", () => {
  const expressions = [
    'import/* call */(/* argument */"./literal/* marker */dep.js"/* options */, options)',
    'import // call\n ( // argument\n "./literal/* marker */dep.js" // end\n )',
  ];
  for (const expression of expressions) {
    assert.deepEqual(extractImports(expression), ["./literal/* marker */dep.js"], expression);
  }
});

test("re-export trivia works across binding forms and preserves quoted source content", () => {
  const content = String.raw`
    export/* export */{ /* } and " inside a comment */ value as renamed }/* from */from/* source */"./literal//dep.js";
    export // export
      * /* from */ from // source
      "./all.js";
    export/* export */*/* namespace */as/* name */\u{61}/* from */from/* source */"./namespace.js";
    export/* export */type/* binding */{ Contract }/* from */from/* source */"./contract.js";
  `;
  assert.deepEqual(extractImports(content), [
    "./literal//dep.js", "./all.js", "./namespace.js", "./contract.js",
  ]);
});

test("comment-separated non-static dependencies deduplicate without removing static occurrences", () => {
  const content = `
    import /* static */ "./shared.js";
    import another /* static */ from "./shared.js";
    const common = module.require("./common.cjs");
    import/* call */("./shared.js"/* end */);
    import/* call */("./common.cjs"/* end */);
    import/* call */("./dynamic.js"/* end */);
    import // call
      ("./dynamic.js");
    export/* binding */{ value }/* from */from "./dynamic.js";
    export/* binding */*/* from */from "./public.js";
    export/* binding */{ other }/* from */from "./public.js";
  `;
  assert.deepEqual(extractImports(content), [
    "./shared.js", "./shared.js", "./common.cjs", "./dynamic.js", "./public.js",
  ]);
});

test("computed imports and ordinary import methods never become dependencies", () => {
  const expressions = [
    'import("./prefix/" + moduleName)',
    'import("./prefix/".concat(moduleName))',
    'import(moduleName, { with: { type: "json" } })',
    'import(`./${moduleName}.js`)',
    'import/* call */(/* argument */"./prefix/"/* value */ + moduleName)',
    'import/* call */("./prefix/"/* value */.concat(moduleName))',
    'import/* call */(moduleName/* options */, options)',
    'import // call\n ("./prefix/" // value\n + moduleName)',
    'object.import("./method.js")',
    'object . import ("./spaced-method.js")',
    'object .    import ("./wide-spaced-method.js")',
    'object?.import("./optional-method.js")',
    'object./* member */ /* another member */import/* call */("./commented-method.js")',
    'object. // member\n import("./line-commented-method.js")',
    'object?. /* member */ import("./optional-commented-method.js")',
    'customimport("./function.js")',
    '$import("./dollar-function.js")',
    '名称import("./unicode-function.js")',
  ];
  for (const expression of expressions) {
    assert.deepEqual(extractImports(expression), [], expression);
  }
});

test("every JavaScript language extension exposes dependency extraction through the existing factory", () => {
  const content = 'import("./lazy.js"); export * from "./public.js";';
  for (const extension of [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]) {
    assert.deepEqual(getLangHandler(`module${extension}`).extractImports(content), [
      "./lazy.js", "./public.js",
    ], extension);
  }
});
