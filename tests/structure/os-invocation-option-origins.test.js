import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const api=fs.readFileSync(new URL('../../src/lib/command-invocation.js',import.meta.url),'utf8');
const file='src/option-origin.mjs';
function inspect(before){
 const source=`import {spawn} from 'node:child_process';
import {NativeExecutableInvocation as Launch} from './command-invocation.js';
class Producer { environment(){return {LABEL:'ordinary'};} invocation(){return new Launch({executable:process.execPath,args:['worker.js'],env:this.environment()});} }
const producer=new Producer();
${before}
const selected=producer.invocation();
spawn(selected.executable,selected.args,{...selected.processOptions(),shell:false});`;
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source],['src/command-invocation.js',api]]),{files:[file]}).check();
 assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));
 return report.diagnostics.filter(entry=>entry.file===file&&entry.line===7);
}
for(const before of ['', 'const other=new Producer();other.environment=foreign;'])test(`ordinary option producer retains its own allocation: ${before}`,()=>{
 assert.deepEqual(inspect(before),[]);
});
for(const before of ['producer.environment=foreign;', 'const alias=producer;alias.environment=foreign;'])test(`a changed field producer retains unresolved origin at native launch: ${before}`,()=>{
 const findings=inspect(before);
 assert.ok(findings.some(entry=>entry.rule==='OS02'&&entry.classification==='incomplete'&&entry.message==='class method has no inspected callable value'),JSON.stringify(findings));
});
