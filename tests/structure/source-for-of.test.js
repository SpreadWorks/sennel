import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as reader from '../support/structure/source-reader.js';
const text=tokens=>tokens.map(token=>token.value).join(' ');
for(const source of [
 'for (const value of values) { use(value); } tail();',
 'for (const [key,value] of Object.entries(input)) { use(key,value); } tail();',
 'for (let of of values) { use(of); } tail();',
 'for (const {name:value} of values) { use(value); } tail();',
 'for (const [value=make("of")] of values) { use(value); } tail();',
])test(`for-of metadata preserves source identities and body boundary: ${source}`,()=>{
 assert.equal(typeof reader.SourceForOf,'function');const module=new reader.SourceModule('loop.mjs',source,{lexicalOnly:true});const loop=reader.SourceForOf.read(module.tokens,0);
 assert.ok(loop instanceof reader.SourceForOf);assert.equal(loop.asynchronous,false);
 assert.ok(loop.target instanceof reader.SourceInitializer);assert.ok(loop.iterable instanceof reader.SourceInitializer);
 assert.ok(loop.target.tokens.every(token=>module.tokens.includes(token)));assert.ok(loop.iterable.tokens.every(token=>module.tokens.includes(token)));
 assert.equal(module.tokens[loop.bodyIndex].value,'{');assert.equal(module.tokens[loop.endIndex].value,'}');assert.equal(module.tokens[loop.endIndex+1].value,'tail');
 assert.equal(text(loop.bodyTokens).startsWith('use ('),true);
 const separator=module.tokens.indexOf(loop.separator);assert.deepEqual(reader.readAssignmentTarget(module.tokens,separator).tokens,loop.target.tokens);
});
for(const source of ['for (const key in input) {}','for (let index=0;index<2;index++) {}','for (const key of values) use(key);','ordinary.for(values);'])test(`unsupported iteration does not become a finite braced for-of: ${source}`,()=>{
 assert.equal(typeof reader.SourceForOf,'function');const tokens=reader.readTokens(source);assert.equal(reader.SourceForOf.read(tokens,0),null);
});
test('asynchronous iteration retains its distinct source contract',()=>{
 assert.equal(typeof reader.SourceForOf,'function');const module=new reader.SourceModule('loop.mjs','for await (const value of values) { use(value); }',{lexicalOnly:true});const loop=reader.SourceForOf.read(module.tokens,0);assert.ok(loop);assert.equal(loop.asynchronous,true);
});
test('for-of lexical binding differs from an enclosing declaration and is shared by nested captures',()=>{
 assert.equal(typeof reader.SourceForOf,'function');const module=new reader.SourceModule('loop.mjs','const value=outer;for(const value of values){const use=()=>value;take(value);}take(value);',{lexicalOnly:true});const start=module.tokens.findIndex(token=>token.value==='for');const loop=reader.SourceForOf.read(module.tokens,start);const tokens=module.tokens.filter(token=>token.value==='value');const bindings=tokens.map(token=>module.bindingAt(token));assert.equal(bindings[0],bindings.at(-1));assert.notEqual(bindings[0],bindings[1]);assert.equal(bindings[1],bindings[2]);assert.equal(bindings[1],bindings[3]);assert.ok(loop.target.tokens.includes(tokens[1]));
});
