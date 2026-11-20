import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/renamed-default-effects.mjs';
function check(source){return new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();}
for(const argument of ["{file:'snapshot.json',unused:fs}","{file:'snapshot.json',unused:{reader:fs.readFileSync}}"]){
 test('a named default selects its supplied field without unrelated capabilities: '+argument,()=>{
  const report=check(`import fs from 'node:fs'; function read({file='fallback.json'}={}){fs.readFileSync(file);} read(${argument});`);
  assert.equal(report.ok,true,report.diagnostics.join('\n')); assert.equal(report.complete,true);
 });
}
for(const mutation of [
 "const alias=input.entry; alias.file='/proc/self/stat'",
 "function change(entry){entry.file='/proc/self/stat';} change(input.entry)",
 "Reflect.set(input.entry,'file','/proc/self/stat')",
 "Object.assign(input.entry,{file:'/proc/self/stat'})",
 "opaque(input)",
 "delete input.entry.file",
]) test('named defaults retain member effects until native I/O: '+mutation,()=>{
 const report=check(`import fs from 'node:fs'; function read({entry:{file='/proc/self/stat'}={}}={}){fs.readFileSync(file);} const input={entry:{file:'snapshot.json'},unused:fs}; ${mutation}; read(input);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
test('a named getter executes its native consumer while binding the field',()=>{
 const report=check(`import fs from 'node:fs'; function read({file='snapshot.json'}={}){return file;} read({get file(){fs.readFileSync('/proc/self/stat');return 'snapshot.json';}});`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01' && entry.classification==='violation'),report.diagnostics.join('\n'));
});
for(const source of [
 `function read({entry:{file}={file:'/proc/self/stat'}}={}){fs.readFileSync(file);} read({entry:undefined});`,
 `function read({entry:{file='snapshot.json'}={}}={entry:{file:'/proc/self/stat'}}){fs.readFileSync(file);} read();`,
]) test('defaults apply at the exact nested selection depth: '+source,()=>{
 const report=check(`import fs from 'node:fs'; ${source}`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
