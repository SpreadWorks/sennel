import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/renamed-mutable-input.mjs';
function check(source){return new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();}
for(const write of ["input.file='/proc/self/stat'", "const alias=input; alias.file='/proc/self/stat'", "const alias=input; alias['file']='/proc/self/stat'"]){
  test('object aliases retain writes at native reads: '+write,()=>{
    const report=check(`import fs from 'node:fs'; const input={file:'snapshot.json'}; ${write}; fs.readFileSync(input.file);`);
    assert.equal(report.ok,false,report.diagnostics.join('\n'));
    assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
  });
}
test('nested aliases retain writes to the projected object',()=>{
 const report=check(`import fs from 'node:fs'; const input={entry:{file:'snapshot.json'}}; const alias=input.entry; alias.file='/proc/self/stat'; fs.readFileSync(input.entry.file);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
for(const write of ["Object.freeze=opaque", "const alias=Object; alias.freeze=opaque", "delete Object.freeze", "Reflect.set=opaque"]){
 test('intrinsic aliases retain their mutation effects: '+write,()=>{
  const report=check(write+';');
  assert.equal(report.ok,false);
  assert.equal(report.complete,false);
 });
}
test('a local intrinsic-name shadow has no global mutation authority',()=>{
 const report=check(`const Object={freeze:1}; Object.freeze=2;`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));
 assert.equal(report.complete,true);
});
for(const write of ["Reflect.set(input,'file','/proc/self/stat')", "Reflect.defineProperty(input,'file',{get(){return '/proc/self/stat';}})", "opaque(input)"]){
 test('reflective or opaque writes invalidate later native member reads: '+write,()=>{
  const report=check(`import fs from 'node:fs'; const input={file:'snapshot.json'}; ${write}; fs.readFileSync(input.file);`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
 });
}
test('opaque exposure of inert data alone has no native consumer',()=>{
 const report=check(`const input={file:'snapshot.json'}; opaque(input);`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));
 assert.equal(report.complete,true);
});
test('opaque consumers can mutate nested aliases reached through supplied data',()=>{
 const report=check(`import fs from 'node:fs'; const entry={file:'snapshot.json'}; const holder={entry}; opaque(holder); fs.readFileSync(entry.file);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
test('repeated calls retain every assigned origin at one member write site',()=>{
 const report=check(`import fs from 'node:fs'; const input={file:'snapshot.json'}; function update(file){input.file=file;} update('/proc/self/stat'); if (choice) update('snapshot.json'); fs.readFileSync(input.file);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
test('an assigned value reaches the real source setter before native I/O',()=>{
 const report=check(`import fs from 'node:fs'; const input={set file(value){fs.readFileSync(value);}}; input.file='/proc/self/stat';`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
test('a module object retains one identity when returned through a helper',()=>{
 const report=check(`import fs from 'node:fs'; const input={file:'snapshot.json'}; function get(){return input;} const alias=get(); alias.file='/proc/self/stat'; fs.readFileSync(input.file);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
for(const write of ["Object=opaque", "({Object}=opaqueInput)", "Reflect=opaque"]){
 test('replacing the global intrinsic binding invalidates its contract: '+write,()=>{
  const report=check(write+';');
  assert.equal(report.ok,false,report.diagnostics.join('\n')); assert.equal(report.complete,false);
 });
}
test('class field names do not assign to the global intrinsic binding',()=>{
 const report=check(`class Value { Object=1; static Reflect=2; } opaque(new Value());`);
 assert.equal(report.ok,true,report.diagnostics.join('\n')); assert.equal(report.complete,true);
});
test('cyclic data writes do not turn sensitivity traversal into an origin cycle',()=>{
 const report=check(`const input={}; input.self=input; if(choice)input.self={}; opaque(input);`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
test('opaque consumers retain aliases introduced by earlier member writes',()=>{
 const report=check(`import fs from 'node:fs'; const entry={file:'snapshot.json'}; const holder={}; holder.entry=entry; opaque(holder); fs.readFileSync(entry.file);`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'),report.diagnostics.join('\n'));
});
for(const write of ['++Object','Object++','--Reflect','for(Object of values){}']){
 test('global intrinsic updates reuse the binding write grammar: '+write,()=>{
  const report=check(write+';');assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.equal(report.complete,false);
 });
}
