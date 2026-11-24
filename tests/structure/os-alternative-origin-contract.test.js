import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
import { portableInvocationSource } from '../support/builders/os-audit-sources.js';
const file='src/renamed-origin-contract.mjs';
function check(source){return new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();}
function refuses(source,rule='OS02'){
 const report=check(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.ok(report.diagnostics.some(entry=>entry.rule===rule),report.diagnostics.join('\n'));return report;
}
const selection="const selected=choice?{file:'/proc/self/stat'}:{file:'snapshot.json'};";
for(const consumer of ['opaque(selected.file);','opaque({file:selected.file});','opaque(()=>selected.file);','class Data { #file=selected.file; read(){return this.#file;} } opaque(new Data());']){
 test('selected path origins remain sensitive at an indirect consumer: '+consumer,()=>{
  const report=refuses(selection+consumer);assert.equal(report.complete,false);
 });
}
test('native flag alternatives reach the same filesystem authority rule',()=>{
 refuses(`import fs from 'node:fs'; const flag=choice?fs.constants.O_NOFOLLOW:fs.constants.O_RDONLY; fs.openSync('snapshot.json',flag);`,'OS03');
});
test('alternative scalar values cannot become a native argv array',()=>{
 const source=portableInvocationSource.replace("launch(new PortableInvocation(process.execPath, ['worker.js']));",`const selected=choice?{args:'worker.js'}:{args:'worker.js'}; launch(new PortableInvocation(process.execPath,selected.args));`);
 const report=refuses(source,'OS04');assert.equal(report.complete,false);
});
test('portable selected fields keep their ordinary data contract',()=>{
 const report=check("const selected=choice?{file:'one.json'}:{file:'two.json'}; opaque(selected.file);");
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
test('alternative scalar executables do not acquire one classified native command',()=>{
 const source=portableInvocationSource.replace("launch(new PortableInvocation(process.execPath, ['worker.js']));",`const selected=choice?{executable:'node'}:{executable:'/bin/sh'}; launch(new PortableInvocation(selected.executable,['worker.js']));`);
 const report=refuses(source);assert.equal(report.complete,false);
});
test('native identity transformations retain a returned callable capability',()=>{
 const report=refuses(`import fs from 'node:fs'; const retain=choice?Object.freeze:Object.seal; opaque(retain(()=>fs.readFileSync));`);
 assert.equal(report.complete,false);
});
