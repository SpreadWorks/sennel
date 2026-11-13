import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SourceModule} from '../support/structure/source-reader.js';
const cases=[
 ['named class fields are property names','class Entry { process = 0; Object = 0; globalThis = 0; }',[false,false,false]],
 ['anonymous class fields are property names','const Entry = class { process = 0; Object = 0; globalThis = 0; };',[false,false,false]],
 ['static, private and accessor names preserve the actual body reference','class Entry { static process = 0; #Object = 0; get global() { return process.pid; } }',[false,false,false,true]],
 ['computed names and static blocks keep their actual global references',"class Entry { [process.env.FIELD] = Object.freeze({}); static { globalThis.mark = 'x'; } }",[true,true,true]],
 ['ordinary object property names keep the actual getter body reference','const value = { process: 0, get Object() { return process.pid; } };',[false,false,true]],
];
for(const[name,source,expected]of cases)test(name,()=>{
 const module=new SourceModule('src/class-role.js',source);
 const actual=module.tokens.filter(token=>token.kind==='identifier'&&['process','Object','#Object','globalThis','global'].includes(token.value)).map(token=>module.isUnbound(token.value,token));
 assert.deepEqual(actual,expected);
});
