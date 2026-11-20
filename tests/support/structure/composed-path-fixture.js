import {MemorySourceRepository} from "./source-repository.js";
import {OsIndependenceChecker} from "./os-independence-checker.js";
export const file="src/path-abstract-consumer.mjs";
export const source="import fs from 'node:fs';\nimport path from 'node:path';\nfunction make(repositoryRoot) {\n  const sanitized = {};\n  sanitized.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(repositoryRoot));\n  return sanitized;\n}\nconst ordinary = 'relative-project';\nconst absolute = '/owned-project';\nconst drive = 'C:relative-project';\nconst pseudo='/proc/self/stat';\nconst holder={read:'ordinary'};\nfunction use(value){return fs.readFileSync(value);}\nfunction escape(value){return foreign(value);}\nfunction late(){holder.read=fs.readFileSync;}\nfunction replace(){path.dirname=foreign;}\nfunction round(value){return fs.readFileSync(foreign(value));}\n";
export class PathSensitivityFixture {
 constructor(name,text=source){this.name=name;this.checker=new OsIndependenceChecker(new MemorySourceRepository([[file,text]]),{files:[file]});this.origins=this.checker.rules.origins;this.module=this.checker.graph.module(file,{lexicalOnly:true});this.caller=new Map();this.make=this.named('make');this.calls=[];this.pathResults=[];const probe=this,invoke=this.origins.invoke;this.origins.invoke=function(callee,args,...rest){const value=Reflect.apply(invoke,this,[callee,args,...rest]);if(callee.builtin==='path')probe.pathResults.push({method:callee.member,value});probe.calls.push({callee:callee.constructor.name,builtin:callee.builtin??null,members:callee.members??null,line:rest[0]?.line,column:rest[0]?.column,result:value.constructor.name});return value;};}
 named(name){return this.origins.value(this.module,this.module.declaration(name).tokens,this.caller);}
 invoke(value,args=[]){return this.origins.invoke(value,args,value.declaration.token,this.module,this.caller);}
 input(name){if(name==='formal')return this.make.effects.parameters.values[0];const literal={relative:'relative-project',rooted:'/owned-project',drive:'C:relative-project',pseudo:'/proc/self/stat'}[name];if(literal){const t=this.module.tokens.find(t=>t.kind==='string'&&t.value===literal);return this.origins.value(this.module,[t],this.caller);}const t=this.module.tokens.find(t=>t.value==='holder');return this.origins.identifier(this.module,t,this.caller);}
 produce(input){for(let i=0;i<8;i++){this.object=this.invoke(this.make,[input]);}this.write=this.object.state.writes.find(w=>w.name==='GIT_CEILING_DIRECTORIES');return this;}
 consume(value,name='use'){const start=this.checker.report.diagnostics.length;this.invoke(this.named(name),[value]);return this.checker.report.diagnostics.slice(start).map(d=>({rule:d.rule,file:d.file,line:d.line,column:d.column,classification:d.classification,message:d.message}));}
}


export function sharedPathSource(depth) {
 let text=source.replace('function make(repositoryRoot) {','function duplicate(value){return path.join(value,value); }\nfunction make(repositoryRoot) {');
 const lines=['const p0=path.resolve(repositoryRoot);'];
 for(let i=1;i<=depth;i++)lines.push('const p'+i+'=duplicate(p'+(i-1)+');');
 return text.replace('sanitized.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(repositoryRoot));',lines.join('')+'sanitized.GIT_CEILING_DIRECTORIES=path.dirname(p'+depth+');');
}
