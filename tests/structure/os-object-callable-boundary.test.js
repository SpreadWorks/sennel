import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule, readInvocations } from '../support/structure/source-reader.js';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/object-signatures.mjs';
const cases=[
  [
    "ordinary-call-block",
    "import fs from 'node:fs';const fn=fs.readFileSync;fn('ordinary.json')\n{}",
    true,
    []
  ],
  [
    "initializer",
    "const value={method({field=\"data\"}={}){return field;}};",
    true,
    [
      "method"
    ]
  ],
  [
    "argument",
    "console.log({method({field=\"data\"}={}){return field;}});",
    true,
    [
      "method"
    ]
  ],
  [
    "group",
    "({method({field=\"data\"}={}){return field;}});",
    true,
    [
      "method"
    ]
  ],
  [
    "array",
    "const values=[{method({field=\"data\"}={}){return field;}}];",
    true,
    [
      "method"
    ]
  ],
  [
    "return",
    "function make(){return {method({field=\"data\"}={}){return field;}}} make();",
    true,
    [
      "make",
      "method"
    ]
  ],
  [
    "nested-property",
    "const value={nested:{method({field=\"data\"}={}){return field;}}};",
    true,
    [
      "method"
    ]
  ],
  [
    "accessor",
    "const value={get field(){return \"ordinary\";},set field(value){}};",
    true,
    [
      "get",
      "field",
      "set",
      "field"
    ]
  ],
  [
    "async-method",
    "const value={async method({field=\"data\"}={}){return field;}};",
    true,
    [
      "async",
      "method"
    ]
  ],
  [
    "generator",
    "const value={*method({field=\"data\"}={}){}};",
    true,
    [
      "*",
      "method"
    ]
  ],
  [
    "async-generator",
    "const value={async *method({field=\"data\"}={}){}};",
    true,
    [
      "async",
      "*",
      "method"
    ]
  ],
  [
    "standalone",
    "import fs from 'node:fs';const fn=fs.readFileSync;{fn('/proc/self/stat')\n{}}",
    false,
    [],
    "fn('/proc/self/stat')"
  ],
  [
    "label",
    "import fs from 'node:fs';const fn=fs.readFileSync;label:{fn('/proc/self/stat')\n{}}",
    false,
    [],
    "fn('/proc/self/stat')"
  ],
  [
    "control",
    "import fs from 'node:fs';const fn=fs.readFileSync;if(flag){fn('/proc/self/stat')\n{}}",
    false,
    [],
    "fn('/proc/self/stat')"
  ],
  [
    "function",
    "import fs from 'node:fs';const fn=fs.readFileSync;function run(){fn('/proc/self/stat')\n{}} run();",
    false,
    [
      "run"
    ],
    "fn('/proc/self/stat')"
  ],
  [
    "arrow",
    "import fs from 'node:fs';const fn=fs.readFileSync;const run=()=>{fn('/proc/self/stat')\n{}}; run();",
    false,
    [],
    "fn('/proc/self/stat')"
  ],
  [
    "staticblock",
    "import fs from 'node:fs';const fn=fs.readFileSync;class A{static{fn('/proc/self/stat')\n{}}}",
    false,
    [],
    "fn('/proc/self/stat')"
  ],
  [
    "return-newline",
    "import fs from 'node:fs';const fn=fs.readFileSync;function run(){return\n{fn('/proc/self/stat')\n{}}} run();",
    false,
    [
      "run"
    ],
    "fn('/proc/self/stat')"
  ],
  [
    "object-default",
    "import fs from 'node:fs';const value={method({field=fs.readFileSync('/proc/self/stat')}={}){return field;}};value.method();",
    false,
    [
      "method"
    ],
    "fs.readFileSync('/proc/self/stat')"
  ],
  [
    "object-computed",
    "import fs from 'node:fs';const value={[fs.readFileSync('/proc/self/stat')](){return 'ordinary';}};",
    false,
    [],
    "fs.readFileSync('/proc/self/stat')"
  ],
  [
    "object-body",
    "import fs from 'node:fs';const value={method(){return fs.readFileSync('/proc/self/stat');}};",
    false,
    [
      "method"
    ],
    "fs.readFileSync('/proc/self/stat')"
  ],
  [
    "object-getter",
    "import fs from 'node:fs';const value={get field(){return fs.readFileSync('/proc/self/stat');}};",
    false,
    [
      "get",
      "field"
    ],
    "fs.readFileSync('/proc/self/stat')"
  ],
  [
    "object-generator-body",
    "import fs from 'node:fs';const value={*method(){fs.readFileSync('/proc/self/stat');}};",
    false,
    [
      "*",
      "method"
    ],
    "fs.readFileSync('/proc/self/stat')"
  ]
];
for(const[name,source,normal,expected,effect]of cases)test(`object method ownership: ${name}`,()=>{
 const module=new SourceModule(file,source);
 assert.deepEqual(module.tokens.filter(token=>module.isCallableDeclarationToken(token)).map(token=>token.value),expected);
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 if(normal){assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);}
 else{const offset=source.indexOf(effect);assert.ok(offset>=0);const prefix=source.slice(0,offset).split('\n');assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===prefix.length&&d.column===prefix.at(-1).length+1),report.diagnostics.join('\n'));}
});
const consumers=[
  "import fs from 'node:fs';const o={*gen(){yield fs.readFileSync;}};opaque(o);",
  "import fs from 'node:fs';const o={async *gen(){yield fs.readFileSync;}};opaque(o);",
  "import fs from 'node:fs';const o={*gen(){yield fs.readFileSync;}};opaque(o.gen);",
  "import fs from 'node:fs';const o={*gen(){yield fs.readFileSync;}};opaque(o.gen());",
  "import fs from 'node:fs';const o={async method(){return fs.readFileSync;}};opaque(o);",
  "import fs from 'node:fs';const o={get method(){return fs.readFileSync;}};opaque(o);",
  "import fs from 'node:fs';const o=flag?{read(){return fs.readFileSync;}}:{read(){return fs.readFileSync;}};opaque(o);",
  "const o=flag?{read(){return 'ordinary';}}:{read(){return 'ordinary';}};console.log(o.read());"
];
for(const [index,source]of consumers.entries())test(`syntax recognition preserves consumer provenance: ${index}`,()=>{
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 if(index===consumers.length-1){assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);}
 else{const column=source.indexOf('opaque(')+1;assert.ok(column>0);assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS02'&&d.line===1&&d.column===column&&d.classification==='incomplete'),report.diagnostics.join('\n'));}
});
test('an actual call followed by a block retains its lexical binding and invocation',()=>{
 const source="import fs from 'node:fs';const fn=fs.readFileSync;fn('/proc/self/stat')\n{}";
 const module=new SourceModule(file,source);const token=module.tokens.filter(t=>t.value==='fn').at(-1);
 assert.equal(module.isCallableDeclarationToken(token),false);
 assert.equal(module.bindingAt(token),module.moduleBinding('fn'));
 assert.ok(module.bindingReferences('fn').includes(token));
 assert.ok(readInvocations(module).some(call=>call.token===token));
});
