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

test("computed imports and ordinary import methods never become dependencies", () => {
  const expressions = [
    'import("./prefix/" + moduleName)',
    'import("./prefix/".concat(moduleName))',
    'import(moduleName, { with: { type: "json" } })',
    'import(`./${moduleName}.js`)',
    'object.import("./method.js")',
    'object . import ("./spaced-method.js")',
    'object .    import ("./wide-spaced-method.js")',
    'object?.import("./optional-method.js")',
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
