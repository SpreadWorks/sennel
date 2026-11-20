import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/renamed-receiver-alternatives.mjs';
function check(source){return new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();}
test('every resolved path implementation is inspected for a logical path calculation',()=>{
 const report=check(`import path from 'node:path'; const api=choice?path.win32:path.posix; api.basename('snapshot.json');`);
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
test('logical path alternatives retain each native interpretation at filesystem use',()=>{
 const report=check(`import path from 'node:path'; import fs from 'node:fs'; const api=choice?path.win32:path.posix; fs.readFileSync(api.normalize('C:\\\\Windows\\\\secret'));`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.ok(report.diagnostics.some(d=>d.rule==='OS01'||d.rule==='OS04'));
});
for(const mutation of ["path.win32.basename=opaque", "Object.freeze=opaque", "Object=opaque", "opaque(path)"]){
 test('receiver alternatives cannot regain a mutated intrinsic identity: '+mutation,()=>{
  const report=check(`import path from 'node:path'; ${mutation}; const api=choice?Object.freeze(path.win32):path.posix; api.basename('snapshot.json');`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.equal(report.complete,false);
 });
}
test('a finite known branch does not make an opaque native receiver inspectable',()=>{
 const report=check(`import path from 'node:path'; const api=choice?opaque():path.posix; api.basename('snapshot.json');`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.equal(report.complete,false);
});
for (const expression of ["path.win32.normalize('C:\\\\Windows\\\\secret').toUpperCase()"]) {
 test('a subsequent string transform retains native path provenance: '+expression,()=>{
  const report=check(`import path from 'node:path'; import fs from 'node:fs'; fs.readFileSync(${expression});`);
  assert.equal(report.ok,false,report.diagnostics.join('\n')); assert.equal(report.complete,false);
  assert.ok(report.diagnostics.some(d=>d.rule==='OS01'||d.rule==='OS04'));
 });
}

test('an exact string replacement retains the concrete pseudo-path violation',()=>{
 const report=check(`import path from 'node:path'; import fs from 'node:fs'; fs.readFileSync('/proc/self/stat'.replace('self','1'));`);
 assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.equal(report.complete,true);
 assert.ok(report.diagnostics.some(d=>d.rule==='OS01'&&d.file===file&&d.line===1&&d.column===57&&d.classification==='violation'),report.diagnostics.join('\n'));
});
