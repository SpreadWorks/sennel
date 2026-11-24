import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/closed-input.mjs';
const fixtures=[
  [
    "first-index",
    true,
    "import fs from 'node:fs';'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    null
  ],
  [
    "all-index",
    false,
    "import fs from 'node:fs';'a a'.replaceAll('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      59,
      "violation"
    ]
  ],
  [
    "original-input",
    true,
    "import fs from 'node:fs';'a a'.replace('a',(_m,_index,input)=>fs.readFileSync(input==='a a'?'ordinary':'/proc/self/stat'));",
    null
  ],
  [
    "matched-input",
    true,
    "import fs from 'node:fs';'a a'.replace('a',(match)=>fs.readFileSync(match==='a'?'ordinary':'/proc/self/stat'));",
    null
  ],
  [
    "changed-matched-input",
    false,
    "import fs from 'node:fs';'a b'.replace('b',(match)=>fs.readFileSync(match==='a'?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      53,
      "violation"
    ]
  ],
  [
    "unknown-owner",
    false,
    "import fs from 'node:fs';String(input).replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      64,
      "incomplete"
    ]
  ],
  [
    "unknown-search",
    false,
    "import fs from 'node:fs';'a a'.replace(input,(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      58,
      "incomplete"
    ]
  ],
  [
    "aliased-callback",
    false,
    "import fs from 'node:fs';const read=(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat');'a a'.replace('a',read);",
    [
      "OS01",
      1,
      49,
      "incomplete"
    ]
  ],
  [
    "assigned-callback",
    false,
    "import fs from 'node:fs';let read;'a a'.replace('a',read=(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      70,
      "incomplete"
    ]
  ],
  [
    "default-parameter",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(_m,index=1)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      58,
      "violation"
    ]
  ],
  [
    "destructured-parameter",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(_m,{index})=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      58,
      "incomplete"
    ]
  ],
  [
    "rest-parameter",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(...args)=>fs.readFileSync(args[1]===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      55,
      "incomplete"
    ]
  ],
  [
    "parameter-write",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(_m,index)=>{index=1;return fs.readFileSync(index===0?'ordinary':'/proc/self/stat');});",
    [
      "OS01",
      1,
      72,
      "incomplete"
    ]
  ],
  [
    "native-before",
    false,
    "import fs from 'node:fs';String.prototype.replace=foreign;'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));",
    [
      "OS01",
      1,
      89,
      "incomplete"
    ]
  ],
  [
    "native-in-extra-argument",
    false,
    "import fs from 'node:fs';function change(){String.prototype.replace=foreign;} 'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'),change());",
    [
      "OS01",
      1,
      109,
      "incomplete"
    ]
  ],
  [
    "extra-argument-io",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'),fs.readFileSync('/proc/self/stat'));",
    [
      "OS01",
      1,
      112,
      "violation"
    ]
  ],
  [
    "extra-getter-io",
    false,
    "import fs from 'node:fs';const option={get value(){return fs.readFileSync('/proc/self/stat');}};'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'),option.value);",
    [
      "OS01",
      1,
      59,
      "violation"
    ]
  ],
  [
    "source-capture",
    false,
    "import fs from 'node:fs';const file='/proc/self/stat';'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?file:'ordinary'));",
    [
      "OS01",
      1,
      85,
      "violation"
    ]
  ],
  [
    "unreached-direct-io",
    false,
    "import fs from 'node:fs';'a a'.replace('absent',()=>fs.readFileSync('/proc/self/stat'));",
    [
      "OS01",
      1,
      53,
      "violation"
    ]
  ],
  [
    "separate-call-sites",
    false,
    "import fs from 'node:fs';'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'ordinary':'/proc/self/stat'));'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?'/proc/self/stat':'ordinary'));",
    [
      "OS01",
      1,
      143,
      "violation"
    ]
  ],
  [
    "data-local-capture",
    true,
    "import fs from 'node:fs';const file='ordinary';'a a'.replace('a',(_m,index)=>fs.readFileSync(index===0?file:'/proc/self/stat'));",
    null
  ]
];
for (const [name, expected, source, consumer] of fixtures) test(name, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.equal(report.ok, expected, JSON.stringify(report.diagnostics));
  if (expected) { assert.equal(report.complete, true); assert.deepEqual(report.diagnostics, []); }
  else assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === consumer[0]
    && entry.line === consumer[1] && entry.column === consumer[2] && entry.classification === consumer[3]), JSON.stringify(report.diagnostics));
});

test('closed input queries repeat actual argument effects and withdraw after native mutation', () => {
  const source = "function extra(){return 0;} 'a a'.replace('a',(_match,index)=>String(index),extra());";
  const changed = 'src/change.mjs';
  const checker = new OsIndependenceChecker(new MemorySourceRepository([[file, source], [changed, 'String.prototype.replace=foreign;']]), { files: [file] });
  const module = checker.graph.module(file, { lexicalOnly: true });
  const origins = checker.rules.origins;
  const extraToken = module.tokens[0];
  const original = origins.invoke;
  let effects = 0;
  origins.invoke = function(callee, ...args) {
    if (callee.declaration?.token === extraToken) effects++;
    return original.call(this, callee, ...args);
  };
  assert.equal(checker.check().ok, true);
  const binding = module.bindingAt(module.tokens.find(token => token.value === 'index'));
  const callback = origins.closedCallInputs.callback(module, binding);
  assert.notEqual(callback, null);
  for (let count = 0; count < 2; count++) {
    const before = effects;
    const input = origins.closedCallInput(module, binding, callback);
    assert.equal(input.value, 0);
    assert.ok(effects > before);
    assert.equal(origins.activeCallInputs.size, 0);
  }
  origins.scan(checker.graph.module(changed, { lexicalOnly: true }));
  const before = effects;
  assert.equal(origins.closedCallInput(module, binding, callback), null);
  assert.ok(effects > before);
  assert.equal(origins.activeCallInputs.size, 0);
});
