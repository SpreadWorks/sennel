import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/primitive-conversion-effects.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, "import fs from 'node:fs';" + source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), [], report.diagnostics.join('\n'));
  return report;
}
for (const source of [
  "opaque(BigInt('1').toString());",
  "opaque(BigInt('0x10').toString());",
  "opaque(BigInt('').toString());",
  "opaque(BigInt(true).toString());",
  "opaque(BigInt(42).toString());",
  "opaque(BigInt(4/2).toString());",
  "opaque(BigInt(0/1).toString());",
  "opaque(BigInt(2*3).toString());",
  "opaque(BigInt(-1).toString());",
  "opaque(BigInt(+1).toString());",
  "opaque(BigInt(unknown===1));",
  "opaque(BigInt(!unknown));",
  "opaque(BigInt(1|2));",
  "opaque(BigInt(4<<1));",
  "const Infinity='1';opaque(BigInt(Infinity));",
  "const NaN='2';opaque(BigInt(NaN));",
  "function convert(Infinity){return BigInt(Infinity);}opaque(convert('1'));",
  "function convert(NaN){return BigInt(NaN);}opaque(convert('2'));",
  "class Value{constructor(input){this.value=BigInt(input);}}const value=new Value('1');opaque(value.value.toString());",
  "class Value{constructor(input){this.value=input.value;}}const value=new Value({value:BigInt('1')});opaque(value.value.toString());",
  "class Value{constructor(input){this.value=BigInt(input);}}function make(input){return new Value(input);}opaque(make('1').value.toString());opaque(make('2').value.toString());",
]) test('genuine primitive conversion retains ordinary exact inputs: ' + source, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
for (const source of [
  "opaque(new BigInt('1'));",
  "opaque(BigInt('ordinary'));",
  "opaque(BigInt('1.5'));",
  "opaque(BigInt(1.5));",
  "opaque(BigInt(null));",
  "opaque(BigInt(undefined));",
  "opaque(BigInt());",
  "opaque(BigInt(1/0));",
  "opaque(BigInt(0/0));",
  "opaque(BigInt(1/2));",
  "opaque(BigInt(-Infinity));",
  "opaque(BigInt(+NaN));",
  "opaque(BigInt(1/0+0));",
  "opaque(BigInt(1/0,fs.readFileSync('/proc/self/stat')));",
  "opaque(BigInt(NaN));",
  "opaque(BigInt(Infinity));",
  "const value=NaN;opaque(BigInt(value));",
  "const value=Infinity;opaque(BigInt(value));",
  "class Value{constructor(input){this.value=BigInt(input);}}opaque(new Value('ordinary'));",
  "opaque(BigInt({valueOf(){fs.readFileSync('/proc/self/stat');return 1;}}));",
  "opaque(BigInt({get valueOf(){fs.readFileSync('/proc/self/stat');return ()=>1;}}));",
  "BigInt=foreign;opaque(BigInt('1'));",
  "BigInt.prototype.toString=foreign;opaque(BigInt('1').toString());",
  "const value=BigInt('1');BigInt.prototype.toString=foreign;opaque(value.toString());",
  "opaque(BigInt.prototype);opaque(BigInt('1').toString());",
  "class Value{constructor(input){this.value=BigInt(input);}}const value=new Value('1');value.value=fs.readFileSync;value.value('/proc/self/stat');",
  "class Value{constructor(input){this.value=BigInt(input);}}function make(input){return new Value(input);}make('1');opaque(make(fs.readFileSync));",
  "opaque(BigInt('1',fs.readFileSync('/proc/self/stat')));",
]) test('primitive convergence preserves failed completion and actual effects: ' + source, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, 'expected refusal');
  assert.ok(report.diagnostics.some(entry => ['OS01', 'OS02'].includes(entry.rule)), report.diagnostics.join('\n'));
});
