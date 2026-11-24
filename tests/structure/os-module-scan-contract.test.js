import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/renamed-module-scan.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[]);
 return report;
}
for(const source of [
 "function create(){return {cwd:'ordinary',shell:false};} const options={...create()};",
 "import fs from 'node:fs';function path(){return 'snapshot.json';} fs.readFileSync(path());",
])test(`module observation resolves its source helper before diagnosing the sink: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of [
 "import fs from 'node:fs';function unused(){fs.readFileSync('/proc/self/stat');}",
 "import fs from 'node:fs';class Unused{read(){fs.readFileSync('/proc/self/stat');}}",
 "import fs from 'node:fs';function outer(){function unused(){fs.readFileSync('/proc/self/stat');}}",
 "import fs from 'node:fs';const read=()=>fs.readFileSync('/proc/self/stat');",
])test(`unreached declarations retain their actual native sink observation: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false);
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'&&entry.column===source.indexOf('fs.readFileSync')+1),report.diagnostics.join('\n'));
});

for(const independentFailure of [false,true])test(`an interrupted deep inspection retains independent findings and every error: ${independentFailure}`,()=>{
 const source="import fs from 'node:fs';fs.readFileSync('/proc/self/stat');";
 const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]});
 const origins=checker.rules.origins;
 const scan=origins.scan;
 origins.scan=function(module,tokens,environment,sensitiveOnly=false){
  if(!this.observing&&module.file===file&&tokens===undefined)throw new RangeError('deep observation interrupted');
  const result=scan.call(this,module,tokens,environment,sensitiveOnly);
  if(!this.observing&&module.file===file&&sensitiveOnly&&independentFailure)throw new Error('independent observation interrupted');
  return result;
 };
 const report=checker.check();
 assert.equal(report.ok,false);assert.equal(report.complete,false);assert.equal(report.coverage.inspected,0);
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'&&entry.classification==='violation'),report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS00'&&entry.message.includes('deep observation interrupted')),report.diagnostics.join('\n'));
 assert.equal(report.diagnostics.some(entry=>entry.rule==='OS00'&&entry.message.includes('independent observation interrupted')),independentFailure);
});
