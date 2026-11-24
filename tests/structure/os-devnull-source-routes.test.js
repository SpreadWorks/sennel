import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/routes.mjs',bridge='src/native.mjs';
const routes=[
 ['default-alias',"import osApi from 'node:os';const importeddevNull=osApi.devNull;",null],
 ['namespace',"import * as osApi from 'node:os';const importeddevNull=osApi.devNull;",null],
 ['named-alias',"import {devNull as importeddevNull} from 'node:os';",null],
 ['named-constant',"import {devNull} from 'node:os';const importeddevNull=devNull;",null],
 ['destructure',"import osApi from 'node:os';const {devNull:importeddevNull}=osApi;",null],
 ['named-reexport',"import {devNull as importeddevNull} from './native.mjs';","export {devNull} from 'node:os';"],
 ['namespace-reexport',"import {osApi} from './native.mjs';const importeddevNull=osApi.devNull;","export * as osApi from 'node:os';"],
 ['default-reexport',"import {osApi} from './native.mjs';const importeddevNull=osApi.devNull;","export {default as osApi} from 'node:os';"],
];
function fixture(source,extra=[]){const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source],...extra]),{files:[file]});return{checker,module:checker.graph.module(file,{lexicalOnly:true}),origins:checker.rules.origins};}
for(const [name,route,exportSource] of routes){
 for(const changed of [false,true])test('native null-device route '+name+(changed?' refuses changed producer':' preserves ordinary consumer'),()=>{
  const mutation=changed?"import osWriter from 'node:os';osWriter.devNull=foreign;":'';
  const source=mutation+route+"import fs from 'node:fs';fs.readFileSync(importeddevNull);";
  const extra=exportSource===null?[]:[[bridge,exportSource]],report=fixture(source,extra).checker.check();
  if(changed){const column=source.indexOf('fs.readFileSync')+1;assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===column&&d.classification==='incomplete'),JSON.stringify(report.diagnostics));}
  else {assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);}
 });
}

test('native mutation rejects fresh reads while retaining the actual earlier stored constant and origin',()=>{
 const source="import os from 'node:os';import fs from 'node:fs';function make(){const object={};object.file=os.devNull;return object;}const value=make();";
 const changed='src/change.mjs';const {checker,module,origins}=fixture(source,[[changed,"import os from 'node:os';os.devNull=foreign;"]]);
 const environment=new Map(),callee=origins.value(module,module.declaration('make').tokens,environment),call=module.tokens.findLast(t=>t.value==='make');
 const object=origins.invoke(callee,[],call,module,environment),write=object.state.writes[0],saved=write.values[0],origin=saved.origin,trace=[...saved.trace],originTrace=[...origin.trace];
 const native=origins.value(module,[module.tokens.findLast(t=>t.value==='os')]);
 const fsToken=module.tokens.findLast(t=>t.value==='fs'),reader=origins.readMember(origins.value(module,[fsToken]),'readFileSync',fsToken,module,environment);
 origins.scan(checker.graph.module(changed,{lexicalOnly:true}));
 const fresh=origins.readMember(native,'devNull',call,module,environment);assert.equal(fresh.constructor.name,'UnknownValue');assert.equal(fresh.sensitive,true);
 const retained=origins.readMember(object,'file',call,module,environment);assert.equal(retained,saved);assert.equal(saved.constructor.name,'DevNullValue');assert.equal(saved.origin,origin);assert.deepEqual(saved.trace,trace);assert.deepEqual(saved.origin.trace,originTrace);
 const OriginalDevNull=saved.constructor,Native=origin.constructor,Write=write.constructor;
 const copy=new OriginalDevNull(new Native('os',['devNull'],originTrace));const revision=object.state.revision;
 object.state.write(new Write(write.token,'file',copy));assert.equal(object.state.revision,revision);assert.equal(write.values.length,1);assert.equal(write.values[0],saved);assert.equal(write.values[0].origin,origin);assert.deepEqual(write.result.trace,trace);
 let observed=null;const onCall=origins.onCall;origins.onCall=function(callee,args,...rest){if(callee===reader)observed=args[0];return onCall.call(this,callee,args,...rest);};
 origins.invoke(reader,[retained],call,module,environment);assert.equal(observed,saved);assert.equal(observed.origin,origin);
});

test('retaining the safe constant does not suppress a later different field FS consumer',()=>{
 const source="import os from 'node:os';import fs from 'node:fs';function make(){const object={};object.file=os.devNull;return object;}const value=make();value.other='/proc/self/stat';fs.readFileSync(value.other);";
 const report=fixture(source).checker.check(),column=source.indexOf('fs.readFileSync')+1;
 assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===column&&d.classification==='violation'),JSON.stringify(report.diagnostics));
});
