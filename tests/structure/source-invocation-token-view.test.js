import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, readInvocations } from "../support/structure/source-reader.js";

const cases = [
  ["registration constructor arguments", "new StepRegistration(Selected, makeArguments());", ["StepRegistration", "makeArguments"]],
  ["class method and default initializer", "class Unit { method(value=defaultInput()){run(value);} } after();", ["defaultInput", "run", "after"]],
  ["generator declaration", "function* generator(value=defaultInput()){run(value);} after();", ["defaultInput", "run", "after"]],
  ["object method inside array", "[{method(value=defaultInput()){run(value);}}];after();", ["defaultInput", "run", "after"]],
  ["object conditional false arm", "const value=flag?{}:{method(input){run(input);}};after();", ["run", "after"]],
  ["nested object initializer", "const value={nested:{method(){run();}}};after();", ["run", "after"]],
  ["async generator and computed effects", "class Unit { async *method(){run();} [computed()](){body();} }", ["run", "computed", "body"]],
  ["actual call before standalone block", "read('/proc/self/stat')\n{}", ["read"]],
  ["actual call inside labelled block", "label:{read('/proc/self/stat')\n{}}", ["read"]],
  ["standalone block is not an object declaration", "{read('/proc/self/stat')\n{}}", ["read"]],
];
for (const [name, source, expected] of cases) test(`token views preserve exact callable ownership: ${name}`, () => {
  const module = new SourceModule("src/token-view.mjs", source, {lexicalOnly:true});
  const fromModule = readInvocations(module);
  const fromView = readInvocations({tokens:module.tokens});
  assert.deepEqual(fromModule.map(call=>call.name), expected);
  assert.deepEqual(fromView.map(call=>call.name), expected);
  assert.deepEqual(fromView.map(call=>call.token), fromModule.map(call=>call.token));
  for (const call of fromView) assert.equal(module.isCallableDeclarationToken(call.token), false);
});
test("body and initializer token fragments retain their actual argument references", () => {
  const module = new SourceModule("src/token-view.mjs", "function make(){const value=new StepRegistration(Selected,build());return value;}", {lexicalOnly:true});
  const declaration = module.declaration("make");
  const calls = readInvocations({tokens:declaration.bodyTokens()});
  assert.deepEqual(calls.map(call=>[call.name,call.constructed]), [["StepRegistration",true],["build",false]]);
  assert.equal(calls[0].arguments[0][0], module.tokens.find(token=>token.value==="Selected"));
});
test("empty token views contain no invocation", () => assert.deepEqual(readInvocations({tokens:[]}), []));
