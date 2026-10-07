import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImports } from "../../../src/docs/lib/lang/js.js";

test("JavaScript imports retain static order and deduplicate CommonJS additions", () => {
  const content = `
    import first from "./first.js";
    import "./side-effect.js";
    import {
      named as renamed,
      other,
    } from './named.js';
    import * as namespace from "./first.js";
    import 名称 from './unicode.js';
    const firstAgain = require("./first.js");
    const common = require('./common.cjs');
    const commonAgain = require('./common.cjs');
  `;
  assert.deepEqual(extractImports(content), [
    "./first.js", "./side-effect.js", "./named.js", "./first.js", "./unicode.js", "./common.cjs",
  ]);
});

test("JavaScript literal dynamic imports and re-exports expose dependencies without computed imports", () => {
  const content = `
    const dynamic = import("./dynamic.js");
    const spaced = import ( './spaced.js' );
    const withAttributes = import('./data.json', { with: { type: 'json' } });
    const same = import('./dynamic.js');
    const computed = import(moduleName);
    const concatenated = import('./prefix/' + moduleName);
    const template = import(\`./\${moduleName}.js\`);
    object.import('./method.js');
    export { one, two as renamed } from './named.js';
    export * from "./all.js";
    export * as namespace from './namespace.js';
    export type { Contract } from './contract.js';
    export { repeated } from './dynamic.js';
  `;
  assert.deepEqual(extractImports(content), [
    "./dynamic.js", "./spaced.js", "./data.json", "./named.js", "./all.js",
    "./namespace.js", "./contract.js",
  ]);
});
