import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
import {SourceModule,matching,readCommaSeparated} from '../support/structure/source-reader.js';
const file='src/message-parts.mjs';
const original="class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure('message');";
const actualText=fs.readFileSync(new URL('../../src/lib/command-invocation.js',import.meta.url),'utf8');
const actualModule=new SourceModule('src/command-invocation.js',actualText),declaration=actualModule.declaration('CommandInvocationError');
const actualClass=actualText.slice(declaration.tokens[0].offset,declaration.tokens.at(-1).offset+1);
const actual=actualClass+"const value=new CommandInvocationError('message');";
const nested=actualClass+"const value=new CommandInvocationError(`${label} must be a string`);";
const effect="import fs from 'node:fs';class Failure extends TypeError{constructor(message,{language='en'}={}){fs.readFileSync('ordinary');const help=language==='ja'?'日本語':'English';super(`${message}. ${help}`);}}const value=new Failure(`${label} must be a string`);";
const bareGuard="class Failure extends TypeError{constructor(message,language){const help=language!=='ja'?'English':'日本語';super(`${message}. ${help}`);}}const value=new Failure('message',choice);";
class MessagePartsFixture {
 constructor(source=actual){
  this.checker=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]});this.module=this.checker.graph.module(file,{lexicalOnly:true});this.origins=this.checker.rules.origins;this.environment=new Map();
  const tokens=this.module.tokens,start=tokens.findLastIndex(t=>t.value==='new'),open=start+2,end=matching(tokens,open,'(',')');this.token=tokens[start];
  this.callee=this.origins.value(this.module,this.module.declaration(tokens[start+1].value).tokens,this.environment);this.args=readCommaSeparated(tokens,open+1,end).map(part=>this.origins.value(this.module,part,this.environment));
  this.count={invokes:0,members:0,fs:0};const fixture=this,invoke=this.origins.invoke,member=this.origins.onMember,call=this.origins.onCall;
  this.origins.invoke=function(...args){fixture.count.invokes++;return invoke.apply(this,args);};
  this.origins.onMember=function(...args){fixture.count.members++;return member.apply(this,args);};
  this.origins.onCall=function(callee,args,...rest){if(callee.builtin==='fs'&&callee.member==='readFileSync')fixture.count.fs++;return call.call(this,callee,args,...rest);};
 }
 read(){this.value=this.origins.invoke(this.callee,this.args,this.token,this.module,this.environment,true);this.write=this.value.state.writes.find(w=>w.name==='message');this.message=this.write.values.at(-1);return this.message;}
 seed(){this.read();return this;}
 template(parts,changes={}){const t=this.message.origin;return new t.constructor(new t.origin.constructor(parts,t.origin.trace),changes.details??t.details,changes.token??t.token,changes.raw??t.raw);}
 output(template){const c=this.message.callContext,context=new c.constructor(c.source,c.callee,c.receiver,c.environment,[template],[],c.trace,c.constructed),v=new this.message.constructor(template).withCallContext(context);v.messageInterpretation=new this.message.messageInterpretation.constructor(context,this.message.messageInterpretation.footprint);return v;}
 same(value){return this.message.constructor.sameOrigins(this.message,value);}
 selection(original,branches=original.origin.values,changes={}){
  const s=original.inputSelection,context=new s.constructor(changes.expression??s.expression,changes.environment??s.environment,changes.condition??s.condition,branches);
  const value=new original.constructor(new original.origin.constructor(branches,original.origin.trace),original.reason,context);if(changes.trace)value.trace=changes.trace;return value;
 }
 replaceHelp(value){const parts=[...this.message.origin.origin.values];parts[2]=value;return this.output(this.template(parts));}
 literal(value,source){const original=source??this.message.origin.origin.values[2].origin.values[0];return new original.constructor(value,original.trace);}
 valueOf(text){const m=new SourceModule('src/negative.mjs',text);return this.origins.value(m,m.tokens,new Map());}
}
for(const [name,source] of [['originalr193',original],['actual class help',actual],['actual class nested message',nested],['nested help plus actual IO effect',effect],['ordinary unknown guard operand',bareGuard]])test('closed message parts retain eight actual interpretations: '+name,t=>{
 const f=new MessagePartsFixture(source),rows=[];
 for(let i=0;i<8;i++){const before={...f.count},observations=f.origins.observations;f.read();rows.push({alternatives:f.write.values.length,revision:f.value.state.revision,invokes:f.count.invokes-before.invokes,members:f.count.members-before.members,fs:f.count.fs-before.fs,observations:f.origins.observations-observations});}
 t.diagnostic(JSON.stringify({name,rows}));assert.deepEqual(rows.map(x=>x.alternatives),Array(8).fill(1));assert.ok(rows.every(x=>x.revision===rows[0].revision));if(name==='nested help plus actual IO effect')assert.deepEqual(rows.map(x=>x.fs),Array(8).fill(1));
});

test('conditional definition comparison factors existing identity without normalizing conditions',()=>{
 const f=new MessagePartsFixture().seed(),help=f.message.origin.origin.values[2],s=help.inputSelection;
 const branches=help.origin.values.map(v=>new v.constructor(v.value,v.trace)),copy=f.selection(help,branches).inputSelection;
 assert.equal(s.hasSameDefinition(copy),true);assert.equal(s.constructor.same(s,copy),false);
 const same=new s.constructor(s.expression,s.environment,s.condition,s.values);assert.equal(s.constructor.same(s,same),true);
});
for(const kind of ['condition operator','condition operand','source definition','environment','branch order','trace','nested token','nested raw','nested trace','native footprint'])test('immutable message part refuses changed '+kind,()=>{
 const f=new MessagePartsFixture(nested).seed(),parts=f.message.origin.origin.values,help=parts[2],s=help.inputSelection;let candidate;
 if(kind==='condition operator')candidate=f.replaceHelp(f.selection(help,help.origin.values,{condition:new s.condition.constructor('!==',s.condition.values)}));
 if(kind==='condition operand'){const operands=[...s.condition.values];operands[1]=f.literal('other',operands[1]);candidate=f.replaceHelp(f.selection(help,help.origin.values,{condition:new s.condition.constructor(s.condition.operator,operands)}));}
 if(kind==='source definition'){const module=new SourceModule('src/other.mjs',"language==='ja'?'日本語':'English'");candidate=f.replaceHelp(f.selection(help,help.origin.values,{expression:new s.expression.constructor(module,module.tokens)}));}
 if(kind==='environment')candidate=f.replaceHelp(f.selection(help,help.origin.values,{environment:new Map(s.environment)}));
 if(kind==='branch order')candidate=f.replaceHelp(f.selection(help,[...help.origin.values].reverse()));
 if(kind==='trace')candidate=f.replaceHelp(f.selection(help,help.origin.values,{trace:['src/other.mjs']}));
 if(kind.startsWith('nested ')){
  const t=parts[1];let token=t.token;if(kind==='nested token'){const m=new SourceModule('src/other.mjs','const value=`${label} must be a string`;');token=m.templates[0];}
  const nested=new t.constructor(t.origin,t.details,token,kind==='nested raw'?!t.raw:t.raw);if(kind==='nested trace')nested.trace=['src/other.mjs'];candidate=f.output(f.template([parts[0],nested,help]));
 }
 if(kind==='native footprint'){f.origins.nativeMutations.add(new f.message.callContext.callee.constructor('Object',['prototype']));candidate=f.output(f.message.origin);}
 assert.equal(f.same(candidate),false);
});
for(const kind of ['platform','authority','heap','callable','opaque','formal'])test('strict message guard refuses same-reference '+kind+' operand',()=>{
 const f=new MessagePartsFixture().seed(),help=f.message.origin.origin.values[2],s=help.inputSelection;let input;
 if(kind==='platform')input=f.valueOf('process.platform');
 if(kind==='authority'){const m=new SourceModule('src/authority.mjs',"import fs from 'node:fs';const value=fs.statSync('ordinary').uid;");const tokens=m.tokens.slice(m.tokens.findIndex(t=>t.value==='=')+1,-1);input=f.origins.value(m,tokens);}
 if(kind==='heap')input=f.valueOf('({value:0})');if(kind==='callable')input=f.valueOf('()=>0');if(kind==='opaque')input=f.valueOf('opaque(input)');
 if(kind==='formal'){const m=new SourceModule('src/formal.mjs','function data(value){return value;}');input=f.origins.value(m,m.declaration('data').tokens,new Map()).effects.parameters.values[0];}
 const condition=new s.condition.constructor('===',[input,s.condition.values[1]]),selection=f.selection(help,help.origin.values,{condition}),output=f.replaceHelp(selection);
 assert.equal(output.constructor.sameOrigins(output,output),false);
});
test('ordinary unknown is an allowed guard operand but is not a standalone branch value',()=>{
 const f=new MessagePartsFixture().seed(),help=f.message.origin.origin.values[2],unknown=help.inputSelection.condition.values[0].origin.values[0];
 assert.equal(unknown.constructor.name,'UnknownValue');assert.equal(f.same(f.replaceHelp(f.selection(help,[unknown,help.origin.values[1]]))),false);
});
test('same-reference heap, formal, callback and opaque conditional branches are not admitted',()=>{
 const f=new MessagePartsFixture().seed(),help=f.message.origin.origin.values[2];const m=new SourceModule('src/formal.mjs','function data(value){return value;}'),formal=f.origins.value(m,m.declaration('data').tokens,new Map()).effects.parameters.values[0];
 for(const value of [f.value,f.valueOf('()=>0'),f.valueOf('opaque(input)'),formal]){const output=f.replaceHelp(f.selection(help,[value,help.origin.values[1]]));assert.equal(output.constructor.sameOrigins(output,output),false);}
});
test('active nested-template cycles are refused without treating repeated acyclic references as a cycle',()=>{
 const f=new MessagePartsFixture(nested).seed(),parts=f.message.origin.origin.values,sharedPart=parts[1];
 const shared=f.output(f.template([parts[0],sharedPart,sharedPart]));assert.equal(shared.constructor.sameOrigins(shared,shared),true);
 const cycle=f.template([...parts]);cycle.origin.values[1]=cycle;const output=f.output(cycle);assert.equal(output.constructor.sameOrigins(output,output),false);
});

function sharedMessageSource(depth) {
 const parts=["function duplicate(value){return `${value}${value}`;}const p0=`${label}`;"];
 for(let i=1;i<=depth;i++)parts.push('const p'+i+'=duplicate(p'+(i-1)+');');
 return parts.join('')+'class Failure extends TypeError{constructor(message){super(message);}}const value=new Failure(p'+depth+');';
}
test('a real shared template DAG checks each leaf pair once within each semantic walk',t=>{
 const depth=8,f=new MessagePartsFixture(sharedMessageSource(depth)).seed();
 let node=f.message.origin;
 for(let i=0;i<depth;i++){assert.equal(node.constructor.name,'TemplateValue');assert.equal(node.origin.values[0],node.origin.values[1]);node=node.origin.values[0];}
 const stringify=JSON.stringify;let leaves=0;
 JSON.stringify=function(value,...args){if(Array.isArray(value)&&value.length===3&&value[0]==='runtime value'&&value[1]===false)leaves++;return stringify.call(this,value,...args);};
 try {assert.equal(f.same(f.message),true);assert.equal(f.same(f.message),true);} finally {JSON.stringify=stringify;}
 t.diagnostic(JSON.stringify({name:'sharedDAG',depth,leaves,twoIndependentWalks:true}));
 assert.equal(leaves,4);
});
test('completed template pair proof cannot bypass the same pair as a strict guard operand',()=>{
 const f=new MessagePartsFixture(nested).seed(),parts=f.message.origin.origin.values,shared=parts[1],help=parts[2],s=help.inputSelection;
 const condition=new s.condition.constructor('===',[shared,s.condition.values[1]]),selection=f.selection(help,help.origin.values,{condition});
 // LIFO visits shared as a template before the condition revisits it as an operand.
 const output=f.output(f.template([parts[0],selection,shared]));
 assert.equal(output.constructor.sameOrigins(output,output),false);
});
