import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/renamed-error-effects.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, `import fs from 'node:fs'; ${source}`]]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}
for (const source of [
  "const error=new Error('ordinary');fs.readFileSync(error.message);",
  "const error=new TypeError('ordinary',{cause:'other.json'});fs.readFileSync(error.cause);",
  "class Renamed extends TypeError{constructor(message){super(message);this.code='ordinary';}}fs.readFileSync(new Renamed('ordinary.json').message);",
  "const error=new Error('ordinary',{get cause(){return 'other.json';}});fs.readFileSync(error.cause);",
  "class Renamed extends RangeError{}fs.readFileSync(new Renamed('ordinary.json').message);",
  "const Native=globalThis.TypeError;fs.readFileSync(new Native('ordinary.json').message);",
  "const error=new Error('ordinary',{cause:'ordinary.json'});error.cause='other.json';fs.readFileSync(error.cause);",
  "const error=new Error('ordinary.json',{cause:function(){return fs.readFileSync(this.message);}});error.cause();",
]) test('native error retains ordinary message and cause: '+source,()=>{
  const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for (const source of [
  "fs.readFileSync(new Error('/proc/self/stat').message);",
  "const error=new Error('ordinary');Reflect.defineProperty(error,'toString',{value:()=>'/proc/self/stat'});fs.readFileSync(String(error));",
  "const error=new Error('ordinary');Reflect.set(error,'message','/proc/self/stat');fs.readFileSync(error.message);",
  "const error=new Error('/proc/self/stat',{cause:function(){return fs.readFileSync(this.message);}});error.cause();",
  "const error=new Error('ordinary',{cause:'/proc/self/stat'});fs.readFileSync(error.cause);",
  "class Renamed extends TypeError{constructor(message){super(message);}}fs.readFileSync(new Renamed('/proc/self/stat').message);",
  "class Renamed extends TypeError{}fs.readFileSync(new Renamed('/proc/self/stat').message);",
  "const error=new Error('ordinary',{get cause(){return fs.readFileSync('/proc/self/stat');}});",
  "const error=new Error('ordinary',{get cause(){return fs.readFileSync;}});opaque(error.cause);",
  "const error=new Error('ordinary',{cause:fs.readFileSync});opaque(error);",
  "const error=new Error('ordinary',{cause:()=>fs.readFileSync('/proc/self/stat')});error.cause();",
  "new Error({toString(){return fs.readFileSync('/proc/self/stat');}});",
  "new Error({[Symbol.toPrimitive](){return fs.readFileSync('/proc/self/stat');}});",
  "Error=foreign;fs.readFileSync(new Error('/proc/self/stat').message);",
  "globalThis.TypeError=foreign;class Renamed extends TypeError{}new Renamed('ordinary');",
  "const Native=TypeError;opaque(Native);class Renamed extends Native{}new Renamed('ordinary');",
  "TypeError.prototype.toString=foreign;class Renamed extends TypeError{}new Renamed('ordinary');",
  "Object.prototype[Symbol.toPrimitive]=()=>'/proc/self/stat';fs.readFileSync(String(new Error('ordinary')));",
  "const options={cause:'ordinary.json'};opaque(options);new Error('ordinary',options);",
  "const error=new Error('ordinary');error.cause='/proc/self/stat';fs.readFileSync(error.cause);",
  "const error=new Error('ordinary',{cause:'ordinary.json'});opaque(error);fs.readFileSync(error.cause);",
]) test('native error preserves coercion, accessor and mutation obligations: '+source,()=>{
  const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
