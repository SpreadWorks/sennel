import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/repeated-effect-records.mjs';
function setup(body){
  const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,
    `import fs from 'node:fs';export function read(){${body}}`]]),{files:[file]});
  const module=checker.graph.module(file,{lexicalOnly:true});
  const environment=new Map();
  return {checker,module,origins:checker.rules.origins,readCallable:()=>checker.rules.origins.value(module,module.declaration('read').tokens,environment)};
}
test('repeated actual source effects retain one sensitivity fact per exact trace without skipping any effect',()=>{
  const count=32;
  const {checker,readCallable}=setup(Array.from({length:count},()=>"fs.readFileSync('/proc/self/stat');").join('\n'));
  const violate=checker.rules.violation;
  let observed=0;
  checker.rules.violation=function(...args){observed++;return violate.apply(this,args);};
  const callable=readCallable();
  assert.equal(callable.sensitive,true);
  assert.equal(observed,count,'every source I/O effect must still be evaluated');
  const records=callable.effects.sensitivityInputs.filter(value=>value.reason==='source has unproven native effects');
  assert.equal(records.length,1,'identical marker facts must not retain one fresh object per observation');
  callable.effects.resolve();
  assert.equal(observed,count*2,'a new summary interpretation must evaluate every source effect again');
  assert.equal(callable.effects.sensitivityInputs.filter(value=>value.reason==='source has unproven native effects').length,1,
    'the new interpretation must recreate its marker after resetting the record set');
  const report=checker.check();
  assert.equal(report.ok,false);
  assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[]);
  assert.equal(report.diagnostics.filter(entry=>entry.rule==='OS01'&&entry.classification==='violation').length,count,
    'summary compaction must retain every actual source-site diagnostic');
});
test('ordinary repeated source reads do not acquire a synthetic sensitive marker',()=>{
  const {checker,readCallable}=setup("fs.readFileSync('ordinary');fs.readFileSync('ordinary');");
  assert.equal(readCallable().sensitive,false);
  assert.equal(checker.check().ok,true);
});
