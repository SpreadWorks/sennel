import assert from "node:assert/strict";
import {test} from "node:test";
import {MemorySourceRepository} from "../support/structure/source-repository.js";
import {OsIndependenceChecker} from "../support/structure/os-independence-checker.js";
const file="src/default-write-retention.mjs";
function setup(source) {
  const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]});
  const module=checker.graph.module(file,{lexicalOnly:true});
  const origins=checker.rules.origins, environment=new Map();
  const callable=origins.value(module,module.declaration("make").tokens,environment);
  const token=callable.declaration.token;
  return {checker,module,origins,callable,invoke:args=>origins.invoke(callable,args,token,module,environment)};
}
test("ordinary default writes converge while every source I/O effect is reinterpreted",()=>{
  const {checker,origins,callable,invoke}=setup("import fs from 'node:fs';function make(input='ordinary'){fs.readFileSync('ordinary');const object={};object.value=input;return object;}");
  const args=callable.effects.parameters.values;
  const original=origins.onCall;let reads=0;
  origins.onCall=function(callee,...rest){if(callee.builtin==='fs'&&callee.member==='readFileSync')reads++;return original.call(this,callee,...rest);};
  let state=null, firstReadCount=null;
  for(let repeat=0;repeat<8;repeat++){
    const prior=reads,result=invoke(args);
    if(state===null)state=result.state;
    assert.equal(result.state,state);
    assert.ok(reads>prior,"every invocation must still inspect its I/O effect");
    firstReadCount??=reads-prior;
    assert.equal(reads-prior,firstReadCount);
    const write=state.writes.find(write=>write.name==='value');
    assert.equal(write.values.length,1,"reinspection of identical default dependencies must not accumulate fresh wrappers");
    assert.equal(state.revision,1);
  }
  assert.deepEqual(checker.report.diagnostics,[]);
});
test("different abstract formal origins never become identical retained defaults",()=>{
  const {callable,invoke}=setup("function make(first='ordinary',second='ordinary'){const object={};object.first=first;object.second=second;return object;}");
  const result=invoke(callable.effects.parameters.values);
  const first=result.state.writes.find(write=>write.name==='first').value;
  const second=result.state.writes.find(write=>write.name==='second').value;
  assert.notEqual(first.origin.values[0],second.origin.values[0]);
  assert.equal(first.constructor.sameOrigins(first,second),false);
});
for(const [source,consumer] of [
  [
    "import fs from 'node:fs';function make(input='ordinary'){const object={};object.value=input;return object;}const value=make(fs.readFileSync);opaque(value.value);",
    [
      "OS01",
      142
    ]
  ],
  [
    "import fs from 'node:fs';function make(input=fs.readFileSync){const object={};object.value=input;return object;}const value=make(unknown);opaque(value.value);",
    [
      "OS02",
      139
    ]
  ],
  [
    "import fs from 'node:fs';const holder={value:'ordinary'};function make(input=holder.value){const object={};object.value=input;return object;}make(unknown);holder.value=fs.readFileSync;opaque(make(unknown).value);",
    [
      "OS02",
      185
    ]
  ],
  [
    "import fs from 'node:fs';function make(input='ordinary'){const object={};object.value=input;return object;}const value=make(unknown);opaque(value);fs.readFileSync(value.value);",
    [
      "OS01",
      148
    ]
  ]
])test(`default write convergence preserves the actual sensitive consumer: ${source}`,()=>{
  const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
  assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[]);
  assert.equal(report.diagnostics.some(entry=>entry.file===file&&entry.line===1&&entry.column===consumer[1]
    &&entry.rule===consumer[0]&&entry.classification==='incomplete'),true,report.diagnostics.join('\n'));
});

test("identical supplied origins cannot merge distinct fallback definitions",()=>{
  const {module,origins,callable}=setup("function make(input){return input;}function left(value='left'){const result={};result.value=value;return result;}function right(value='right'){const result={};result.value=value;return result;}");
  const input=callable.effects.parameters.values[0];
  const values=["left","right"].map(name=>{
    const target=origins.value(module,module.declaration(name).tokens,callable.environment);
    const result=origins.invoke(target,[input],target.declaration.token,module,callable.environment);
    return result.state.writes.find(write=>write.name==='value').value;
  });
  assert.equal(values[0].origin.values[0],values[1].origin.values[0]);
  assert.equal(values[0].constructor.sameOrigins(values[0],values[1]),false);
});
