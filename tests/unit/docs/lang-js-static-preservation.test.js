import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImports } from "../../../src/docs/lib/lang/js.js";

test("static imports preserve a comment between import and the binding", () => {
  assert.deepEqual(extractImports('import /* comment */ name from "./dep.mjs";'), ["./dep.mjs"]);
});

test("static imports preserve a comment between the binding and from", () => {
  assert.deepEqual(extractImports('import name /* comment */ from "./dep.mjs";'), ["./dep.mjs"]);
});

test("static imports preserve a Unicode escape in the binding", () => {
  assert.deepEqual(extractImports(String.raw`import \u0061 from "./escaped.mjs";`), ["./escaped.mjs"]);
});

test("static import trivia works across binding forms without changing order or duplicates", () => {
  const content = String.raw`
    import /* a quote and } inside trivia: " */ first from "./first.mjs";
    import second // line comment
      from /* before the specifier */ "./second.mjs";
    import primary /* comma trivia */, /* namespace trivia */ * /* as trivia */ as \u{61} /* from trivia */ from "./namespace.mjs";
    import { /* } inside a comment */ named as local } /* from trivia */ from "./named.mjs";
    import type /* binding trivia */ Contract /* from trivia */ from "./contract.mjs";
    import /* side-effect trivia */ "./first.mjs";
  `;
  assert.deepEqual(extractImports(content), [
    "./first.mjs", "./second.mjs", "./namespace.mjs", "./named.mjs", "./contract.mjs", "./first.mjs",
  ]);
});

test("comment syntax in module specifiers remains literal source content", () => {
  const content = `
    const marker = "/* this is a string */";
    import /* declaration trivia */ one from "./literal/* marker */dep.mjs";
    import other /* declaration trivia */ from "./literal//dep.mjs";
  `;
  assert.deepEqual(extractImports(content), ["./literal/* marker */dep.mjs", "./literal//dep.mjs"]);
});

test("comment-aware static imports stay separate from dynamic and re-export additions", () => {
  const content = `
    const lazy = import ("./dynamic.mjs", options);
    export { publicName } from "./re-export.mjs";
    import /* static trivia */ first from "./static.mjs";
    import second /* static trivia */ from "./static.mjs";
    const common = module.require("./common.cjs");
    import("./static.mjs");
    import("./prefix/" + moduleName);
    object . import("./method.mjs");
    名称import("./suffix.mjs");
  `;
  assert.deepEqual(extractImports(content), [
    "./static.mjs", "./static.mjs", "./common.cjs", "./dynamic.mjs", "./re-export.mjs",
  ]);
});
