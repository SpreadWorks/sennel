import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/object-origin-probe.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';\n"+source]]),{files:[file]}).check();
 assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));
 return report;
}
for(const source of [
 "const holder=new foreign('/proc/self/stat');\nopaque(holder);",
 "const holder=new foreign(['/proc/self/stat']);\nopaque(holder);",
 "const holder=new foreign({file:'/proc/self/stat'});\nopaque(holder);",
 "const input={file:'ordinary'};class Holder{value=new foreign(input);}const holder=new Holder();input.file='/proc/self/stat';\nopaque(holder.value);",
 "const input={read(){return 'ordinary';}};class Holder{value=new foreign(input);}const holder=new Holder();input.read=fs.readFileSync;\nopaque(holder.value);",
 "const input={};const holder=new foreign({input,get later(){input.file='/proc/self/stat';return 0;},again:input});\nopaque(holder);",
 "const input={};input.self=input;const holder=new foreign(input);input.file='/proc/self/stat';\nopaque(holder);",
])test(`unknown construction keeps object and heap origins at its actual consumer: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false);assert.equal(report.complete,false);
 assert.ok(report.diagnostics.some(entry=>entry.line===3&&entry.column===1&&entry.rule==='OS02'&&entry.classification==='incomplete'),report.diagnostics.join('\n'));
});
for(const source of [
 "const input={file:'ordinary'};input.file='/proc/self/stat';",
 "const input={file:'/proc/self/stat'};const saved={input};",
 "const input={};input.self=input;const holder=new foreign(input);opaque(holder);",
])test(`ordinary stored data grants no native use: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
test('the actual filesystem consumer keeps the retained object path finding',()=>{
 const report=inspect("const input={file:'ordinary'};class Holder{value=new foreign(input);}const holder=new Holder();input.file='/proc/self/stat';\nfs.readFileSync(input.file);");
 assert.equal(report.ok,false);assert.ok(report.diagnostics.some(entry=>entry.line===3&&entry.column===1&&entry.rule==='OS01'),report.diagnostics.join('\n'));
});
