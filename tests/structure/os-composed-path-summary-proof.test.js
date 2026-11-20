import assert from 'node:assert/strict';
import {test} from 'node:test';
import {source,PathSensitivityFixture,sharedPathSource} from '../support/structure/composed-path-fixture.js';
function seeded(text=source){const p=new PathSensitivityFixture('formal',text);p.produce(p.input('formal'));return p;}
function pair(p){const values=p.pathResults.filter(r=>r.method==='dirname').map(r=>r.value);return [values[0],values.at(-1)];}
function copy(value,changes={}){return new value.constructor(changes.interpretations??value.interpretations,changes.trace??value.trace,changes.consumesPosix??value.consumesPosix);}
function entry(value,changes={}){return new value.constructor(changes.syntax??value.syntax,changes.values??value.values,Object.hasOwn(changes,'text')?changes.text:value.text);}
for(const field of ['syntax order','nullable text','ordered values','trace','consumesPosix','nested wrapper','formal leaf','heap leaf','opaque leaf','optional metadata'])test('exact path summary refuses changed '+field,()=>{
 let text=source.replace('make(repositoryRoot)', 'make(repositoryRoot,other)').replace('path.resolve(repositoryRoot)', 'path.resolve(repositoryRoot,other)');
 text+='function opaque(){return foreign();}function context(){return foreign(\'ordinary\');}const otherHolder={read:\'ordinary\'};';
 const p=seeded(text),[left,right]=pair(p);let next;
 if(field==='syntax order')next=copy(right,{interpretations:[...right.interpretations].reverse()});
 if(field==='nullable text')next=copy(right,{interpretations:right.interpretations.map((e,i)=>entry(e,{text:i===0?'/different':e.text}))});
 if(field==='trace')next=copy(right,{trace:['src/different.mjs']});
 if(field==='consumesPosix')next=copy(right,{consumesPosix:!right.consumesPosix});
 if(['ordered values','nested wrapper','formal leaf','heap leaf','opaque leaf'].includes(field)){
  const inner=right.interpretations[0].values[0];let entries=inner.interpretations;
  if(field==='ordered values')entries=entries.map(e=>entry(e,{values:[...e.values].reverse()}));
  if(field==='nested wrapper')entries=entries.map(e=>entry(e,{text:'different'}));
  if(field.endsWith('leaf')){
   let value;
   if(field==='formal leaf')value=p.make.effects.parameters.values[1];
   if(field==='heap leaf')value=p.origins.identifier(p.module,p.module.tokens.find(t=>t.value==='otherHolder'),p.caller);
   if(field==='opaque leaf')value=p.invoke(p.named('opaque'));
   entries=entries.map(e=>entry(e,{values:[value,...e.values.slice(1)]}));
  }
  const nested=copy(inner,{interpretations:entries});next=copy(right,{interpretations:right.interpretations.map(e=>entry(e,{values:[nested]}))});
 }
 if(field==='optional metadata'){
  next=copy(right);next.withCallContext(p.invoke(p.named('context')).callContext);
 }
 assert.equal(left.constructor.sameAbstractOrigins(left,next),false);
});
test('matching abstract summaries keep unresolved values and do not acquire operation or concrete-value proof',()=>{
 const text=source+"function rawResolve(input){return path.resolve(input);}function rawJoin(input){return path.join(input);}";
 const p=seeded(text),input=p.input('formal'),resolve=p.invoke(p.named('rawResolve'),[input]),join=p.invoke(p.named('rawJoin'),[input]);
 const before=p.calls.length;assert.notEqual(resolve,join);assert.equal(resolve.constructor.sameAbstractOrigins(resolve,join),true);assert.equal(p.calls.length,before);
 assert.deepEqual(resolve.interpretations.map(e=>e.text),[null,null]);assert.equal(resolve.values[0],input);assert.equal(resolve.allocationState,null);assert.equal(resolve.callContext,undefined);
});
test('fresh unchanged default wrappers reuse only their existing type-owned exact origins',()=>{
 const p=seeded(source.replace('make(repositoryRoot)',"make(repositoryRoot='relative-project')")),[left,right]=pair(p);
 assert.notEqual(left,right);assert.equal(left.constructor.sameAbstractOrigins(left,right),true);
});
test('a changed native inner result is a different leaf even when logical texts remain null',()=>{
 const p=seeded(source+"function change(){path.resolve=foreign;}"),saved=pair(p)[0];p.invoke(p.named('change'));p.invoke(p.make,[p.input('formal')]);const fresh=pair(p)[1];
 assert.equal(fresh.constructor.name,'ComposedPathValue');assert.equal(saved.constructor.sameAbstractOrigins(saved,fresh),false);
});
test('active cyclic path summaries refuse comparison without a successful-value cache',()=>{
 const p=seeded(),value=pair(p)[0],values=[value],interpretations=value.interpretations.map(e=>entry(e,{values,text:null}));
 const cycle=copy(value,{interpretations});values[0]=cycle;cycle.values[0]=cycle;
 assert.equal(cycle.constructor.sameAbstractOrigins(cycle,cycle),false);
});
test('a real shared path DAG compares bounded pairs anew for each query',t=>{
 const depth=9,p=seeded(sharedPathSource(depth)),[left,right]=pair(p),seen=new Set(),pending=[left],arrays=[];
 while(pending.length){const value=pending.pop();if(seen.has(value)||value.constructor!==left.constructor)continue;seen.add(value);arrays.push(value.trace);pending.push(...value.values);}
 let visits=0;const originals=arrays.map(trace=>trace.every);
 arrays.forEach(trace=>{trace.every=function(...args){visits++;return Reflect.apply(Array.prototype.every,this,args);};});
 try{assert.equal(left.constructor.sameAbstractOrigins(left,right),true);const first=visits;assert.ok(first>0);assert.ok(first<=4*(depth+2),String(first));assert.equal(left.constructor.sameAbstractOrigins(left,right),true);assert.equal(visits,2*first);t.diagnostic(JSON.stringify({depth,retainedNodes:seen.size,firstVisits:first,twoQueries:visits}));}
 finally{arrays.forEach((trace,i)=>{trace.every=originals[i];});}
});
for(const kind of ['heap','opaque'])test('distinct '+kind+' input references remain different despite identical unknown path clues',()=>{
 const text=source+"const otherHolder={read:'ordinary'};function opaque(){return foreign();}";
 const p=new PathSensitivityFixture(kind,text);
 let first,second;
 if(kind==='heap'){
  first=p.input('lateHeap');second=p.origins.identifier(p.module,p.module.tokens.find(t=>t.value==='otherHolder'),p.caller);
 }else{first=p.invoke(p.named('opaque'));second=p.invoke(p.named('opaque'));}
 assert.equal(first.constructor,second.constructor);assert.notEqual(first,second);
 p.produce(first);const left=p.pathResults.filter(r=>r.method==='dirname').at(-1).value;
 p.produce(second);const right=p.pathResults.filter(r=>r.method==='dirname').at(-1).value;
 assert.deepEqual(left.interpretations.map(e=>e.text),right.interpretations.map(e=>e.text));assert.equal(left.constructor.sameAbstractOrigins(left,right),false);
});
test('a stale generated union cannot be treated as the same complete dependency summary',()=>{
 const p=seeded(),[left,right]=pair(p),next=copy(right);next.values.push(p.input('pseudo'));
 assert.equal(left.constructor.sameAbstractOrigins(left,next),false);
});
test('the real retained field still refuses the exact public FS consumer after duplicate elimination',()=>{
 const p=seeded(source.replace('function use(value)', 'export function use(value)'));
 p.produce(p.input('pseudo'));const value=p.write.value,diagnostics=p.consume(value);
 assert.equal(p.write.values.length,1);assert.ok(diagnostics.some(d=>d.rule==='OS01'&&d.line===13&&d.column===35&&d.classification==='violation'),JSON.stringify(diagnostics));
});
