import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/member-put-value.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,`import fs from 'node:fs';${source}`]]),{files:[file]}).check();
 assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));return report;
}
for(const source of [
 "const box={};const other={};fs.readFileSync(box.file=other.file='ordinary.json');",
 "const box={get file(){return fs.readFileSync;},set file(value){}};box.file='ordinary.json';",
 "class Box{get file(){return fs.readFileSync;}set file(value){}}new Box().file='ordinary.json';",
 "const box={};fs.readFileSync(box.file='ordinary.json');",
 "const box={};const result=(box.file='ordinary.json');fs.readFileSync(result);",
])test(`assignment does not read its target and returns its actual RHS: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of [
 "const box={};const read=(box.reader=fs.readFileSync);read('/proc/self/stat');",
 "const box={};const other={};box.file=other.file='/proc/self/stat';fs.readFileSync(box.file);fs.readFileSync(other.file);",
 "const box={};box[fs.readFileSync('/proc/self/stat')]='ordinary';",
 "const box={get count(){fs.readFileSync('/proc/self/stat');return 0;},set count(value){}};box.count+=1;",
 "const box={get count(){fs.readFileSync('/proc/self/stat');return 0;},set count(value){}};box.count++;",
 "const box={set file(value){fs.readFileSync(value);}};box.file='/proc/self/stat';",
 "const outer={get child(){return {set file(value){fs.readFileSync(value);}};}};outer.child.file='/proc/self/stat';",
 "const box={};box.value=fs.readFileSync('/proc/self/stat');",
 "const box={};fs.readFileSync(box.file='/proc/self/stat');",
])test(`assignment retains receiver, setter and RHS native effects: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'&&entry.classification==='violation'),report.diagnostics.join('\n'));
});
