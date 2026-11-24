import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/result-origin-cycle.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const create of ['foreign(input)','new foreign(input)']){
 test(`ordinary result backedge does not create sensitivity or recursive query: ${create}`,()=>{
 const report=inspect(`const input={};const result=${create};input.back=result;opaque(result);`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
 });
 for(const field of ['read:fs.readFileSync','file:"/proc/self/stat"'])test(`result backedge retains the sensitive edge without recursive query: ${create} ${field}`,()=>{
 const report=inspect(`const input={${field}};const result=${create};input.back=result;opaque(result);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 });
}
for(const source of [
 'const input={file:"/proc/self/stat"};const result=foreign(input);opaque({input,result});',
 'const input={};const result=foreign(input);const holder={result,get inspect(){input.file="/proc/self/stat";return 0;}};opaque(holder);',
 'const input={};const result=new foreign(input);const holder={result,get inspect(){input.file="/proc/self/stat";return 0;}};opaque(holder);',
])test(`sensitivity visits preserve later provenance mode and heap revision: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
test('shared ordinary inputs stay ordinary in both sensitivity path modes',()=>{
 const report=inspect('const input={file:"ordinary"};const result=foreign(input);opaque({input,result});');
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
