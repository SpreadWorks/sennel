import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, readInvocations } from "../support/structure/source-reader.js";

const cases = [
  ["control head", "if (ok) { work(); }", ["work"]],
  ["anonymous function keyword", "const build=function(value){return value;};", []],
  ["control condition and body calls", "if (condition()) { work(); }", ["condition", "work"]],
  ["anonymous default and body calls", "const build=function(value=defaultInput()){return work(value);};", ["defaultInput", "work"]],
  ["async anonymous default and body calls", "const build=async function(value=defaultInput()){return work(value);};", ["defaultInput", "work"]],
  ["actual call before a standalone block", "work()\n{}", ["work"]],
  ["all existing control-head kinds", "for (start(); condition(); advance()) { work(); } while (condition()) { work(); } switch (select()) { default: work(); } try { work(); } catch (error) { work(); }", ["start", "condition", "advance", "work", "condition", "work", "select", "work", "work", "work"]],
  ["function-valued argument and later call", "consume(function(value=defaultInput()){return work(value);}); after();", ["consume", "defaultInput", "work", "after"]],
];
for (const [name, source, expected] of cases) test(`named invocation excludes only syntax heads: ${name}`, () => {
  const module = new SourceModule("src/named-call.mjs", source, {lexicalOnly:true});
  for (const input of [module, {tokens:module.tokens}]) {
    const calls=readInvocations(input);
    assert.deepEqual(calls.map(call=>call.name),expected);
    for(const call of calls) assert.equal(call.token,module.tokens.find(token=>token.offset===call.token.offset));
  }
});
