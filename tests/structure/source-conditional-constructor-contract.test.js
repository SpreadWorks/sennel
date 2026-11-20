import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceConditionalExpression, readTokens } from '../support/structure/source-reader.js';
for(const [name,source,question,alternate] of [
 ['string question',"flag '?' left : right",1,3],
 ['string colon',"flag ? left ':' right",1,3],
 ['optional member','value?.field : right',1,4],
 ['nullish operator','value ?? other : right',2,4],
])test(`conditional constructor refuses ${name} as ternary syntax`,()=>{
 const tokens=readTokens(source);assert.throws(()=>new SourceConditionalExpression(tokens,question,alternate),TypeError);
 assert.equal(SourceConditionalExpression.read(tokens),null);
});
test('conditional factory and direct construction retain the same valid token boundaries',()=>{
 const tokens=readTokens('flag ? left : right');const factory=SourceConditionalExpression.read(tokens);
 const direct=new SourceConditionalExpression(tokens,1,3);assert.ok(factory instanceof SourceConditionalExpression);
 assert.deepEqual(factory.condition,direct.condition);assert.deepEqual(factory.consequent,direct.consequent);assert.deepEqual(factory.alternate,direct.alternate);
});
