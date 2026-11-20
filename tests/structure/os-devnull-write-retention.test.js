import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/devnull-unit.mjs';
const original="import os from 'node:os';function make(){const object={};object.file=os.devNull;return object;}const value=make();";
function setup(source=original,extra=[]){
 const checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source],...extra]),{files:[file]});
 return{checker,module:checker.graph.module(file,{lexicalOnly:true}),origins:checker.rules.origins};
}
function interpretFixture(){
 const {checker,module,origins}=setup();const environment=new Map();const declaration=module.declaration('make');
 const callee=origins.value(module,declaration.tokens,environment);const call=module.tokens.findLast(token=>token.value==='make');
 return{checker,module,origins,environment,callee,call,interpret(){return origins.invoke(callee,[],call,module,environment);}};
}

test('repeated null-device writes converge after all eight native read effects',t=>{
 const fixture=interpretFixture(),{origins}=fixture;const member=origins.onMember;let effects=0;
 origins.onMember=function(receiver,name,...rest){if(receiver.builtin==='os'&&name==='devNull')effects++;return member.call(this,receiver,name,...rest);};
 const observations=[];
 for(let i=0;i<8;i++){const prior=effects,value=fixture.interpret();observations.push({revision:value.state.revision,alternatives:value.state.writes[0].values.length,nativeReadEffects:effects-prior});}
 t.diagnostic(JSON.stringify(observations));
 assert.deepEqual(observations,Array.from({length:8},()=>({revision:1,alternatives:1,nativeReadEffects:2})));
});

for(const variant of ['same-native','wrong-native','wrong-name','extra-member','origin-subclass','value-subclass','different-origin-trace','different-value-trace','non-null-details'])test('null-device retained write identity: '+variant,()=>{
 const fixture=interpretFixture(),object=fixture.interpret(),effect=object.state.writes[0],base=effect.values[0];
 const DevNull=base.constructor,Builtin=base.origin.constructor,Write=effect.constructor;
 let origin=new Builtin('os',['devNull'],base.origin.trace);
 if(variant==='wrong-native')origin=new Builtin('fs',['devNull'],base.origin.trace);
 if(variant==='wrong-name')origin=new Builtin('os',['other'],base.origin.trace);
 if(variant==='extra-member')origin=new Builtin('os',['userInfo','devNull'],base.origin.trace);
 if(variant==='origin-subclass'){class OtherBuiltin extends Builtin{}origin=new OtherBuiltin('os',['devNull'],base.origin.trace);}
 if(variant==='different-origin-trace')origin=new Builtin('os',['devNull'],['src/other.mjs']);
 let value=new DevNull(origin,variant==='non-null-details'?'other':null);
 if(variant==='value-subclass'){class OtherDevNull extends DevNull{}value=new OtherDevNull(origin);}
 if(variant==='different-value-trace')value.trace=['src/wrapper.mjs'];
 const write=new Write(effect.token,'file',base),changed=write.add(new Write(effect.token,'file',value));
 assert.equal(changed,variant!=='same-native');assert.equal(write.values.length,variant==='same-native'?1:2);
 assert.equal(write.values[0],base);
 if(variant!=='same-native')assert.equal(write.values[1],value);
});

const invalidNative=[
 ['direct-change',"os.devNull='/proc/self/stat';"],
 ['alias-change',"const alias=os;alias.devNull='/proc/self/stat';"],
 ['descriptor-change',"Object.defineProperty(os,'devNull',{value:'/proc/self/stat'});"],
 ['opaque-native',"foreign(os);"],
 ['opaque-holder',"foreign({os});"],
];
for(const [name,mutation] of invalidNative)test('changed null-device producer withdraws genuine identity: '+name,()=>{
 const changed='src/native-change.mjs';const {checker,module,origins}=setup("import os from 'node:os';const native=os;",[[changed,"import os from 'node:os';"+mutation]]);
 const nativeToken=module.tokens.findLast(token=>token.value==='os'),receiver=origins.value(module,[nativeToken]);
 const value=origins.readMember(receiver,'devNull',nativeToken,module,new Map()),DevNull=value.constructor;
 assert.equal(value.constructor.name,'DevNullValue');
 origins.scan(checker.graph.module(changed,{lexicalOnly:true}));
 const invalid=origins.readMember(receiver,'devNull',nativeToken,module,new Map());
 assert.equal(invalid instanceof DevNull,false);assert.equal(invalid.sensitive,true);
 const restored=setup("import os from 'node:os';const native=os;");
 const token=restored.module.tokens.findLast(token=>token.value==='os');
 assert.equal(restored.origins.readMember(restored.origins.value(restored.module,[token]),'devNull',token,restored.module,new Map()).constructor.name,'DevNullValue');
});

for(const [name,mutation] of [...invalidNative,['wrong-member-owner','']])test('null-device invalid provenance is refused at actual FS consumer: '+name,()=>{
 const source="import os from 'node:os';import fs from 'node:fs';"+mutation+"fs.readFileSync("+(name==='wrong-member-owner'?'os.userInfo.devNull':'os.devNull')+");";
 const report=setup(source).checker.check(),column=source.indexOf('fs.readFileSync')+1;
 assert.ok(report.diagnostics.some(d=>d.rule==='OS01'&&d.file===file&&d.line===1&&d.column===column&&d.classification==='incomplete'),JSON.stringify(report.diagnostics));
 const ordinary="import os from 'node:os';import fs from 'node:fs';fs.readFileSync(os.devNull);";
 const restored=setup(ordinary).checker.check();assert.equal(restored.ok,true);assert.equal(restored.complete,true);assert.deepEqual(restored.diagnostics,[]);
});

test('escaping a null-device string does not escape the native object',()=>{
 const report=setup("import os from 'node:os';import fs from 'node:fs';foreign(os.devNull);fs.readFileSync(os.devNull);").checker.check();
 assert.equal(report.ok,true);assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);
});

for(const [name,tail,column] of [
 ['later-path-write',"value.file='/proc/self/stat';fs.readFileSync(value.file);",169],
 ['later-capability-write',"value.read=fs.readFileSync;foreign(value);",167],
])test('null-device duplicate retention preserves '+name,()=>{
 const source=original.replace("import os from 'node:os';","import os from 'node:os';import fs from 'node:fs';")+tail,report=setup(source).checker.check();
 assert.ok(report.diagnostics.some(d=>d.file===file&&d.line===1&&d.column===column&&d.rule===(name==='later-path-write'?'OS01':'OS02')&&d.classification==='incomplete'),JSON.stringify(report.diagnostics));
 const restored=setup(original.replace("import os from 'node:os';","import os from 'node:os';import fs from 'node:fs';")+"fs.readFileSync(value.file);").checker.check();assert.equal(restored.ok,true);assert.equal(restored.complete,true);assert.deepEqual(restored.diagnostics,[]);
});
