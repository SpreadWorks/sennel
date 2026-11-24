import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceModule, SourceInputBinding } from '../support/structure/source-reader.js';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const formalCases=[
  {
    "name": "export-default / return read; / ordinary",
    "position": "export-default",
    "body": "return read;",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/producer.mjs",
        "export default {method(read){return read;}};"
      ],
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';import selected from './producer.mjs';const result=selected.method(\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "export-default / return read; / native",
    "position": "export-default",
    "body": "return read;",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/producer.mjs",
        "export default {method(read){return read;}};"
      ],
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';import selected from './producer.mjs';const result=selected.method(fs.readFileSync);opaque(result);"
      ]
    ]
  },
  {
    "name": "export-default / return read(\"/proc/self/stat\"); / ordinary",
    "position": "export-default",
    "body": "return read(\"/proc/self/stat\");",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/producer.mjs",
        "export default {method(read){return read(\"/proc/self/stat\");}};"
      ],
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';import selected from './producer.mjs';const result=selected.method(()=>\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "export-default / return read(\"/proc/self/stat\"); / native",
    "position": "export-default",
    "body": "return read(\"/proc/self/stat\");",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/producer.mjs",
        "export default {method(read){return read(\"/proc/self/stat\");}};"
      ],
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';import selected from './producer.mjs';const result=selected.method(fs.readFileSync);console.log(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read; / ordinary",
    "position": "conditional-false",
    "body": "return read;",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=false?{}:{method(read){return read;}};const result=selected.method(\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read; / native",
    "position": "conditional-false",
    "body": "return read;",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=false?{}:{method(read){return read;}};const result=selected.method(fs.readFileSync);opaque(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read(\"/proc/self/stat\"); / ordinary",
    "position": "conditional-false",
    "body": "return read(\"/proc/self/stat\");",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=false?{}:{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(()=>\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read(\"/proc/self/stat\"); / native",
    "position": "conditional-false",
    "body": "return read(\"/proc/self/stat\");",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=false?{}:{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(fs.readFileSync);console.log(result);"
      ]
    ]
  },
  {
    "name": "logical-rhs / return read; / ordinary",
    "position": "logical-rhs",
    "body": "return read;",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const value=null;const selected=value||{method(read){return read;}};const result=selected.method(\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "logical-rhs / return read; / native",
    "position": "logical-rhs",
    "body": "return read;",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const value=null;const selected=value||{method(read){return read;}};const result=selected.method(fs.readFileSync);opaque(result);"
      ]
    ]
  },
  {
    "name": "logical-rhs / return read(\"/proc/self/stat\"); / ordinary",
    "position": "logical-rhs",
    "body": "return read(\"/proc/self/stat\");",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const value=null;const selected=value||{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(()=>\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "logical-rhs / return read(\"/proc/self/stat\"); / native",
    "position": "logical-rhs",
    "body": "return read(\"/proc/self/stat\");",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const value=null;const selected=value||{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(fs.readFileSync);console.log(result);"
      ]
    ]
  }
];
for(const input of formalCases)test(`method formal ownership: ${input.name}`,()=>{
 const [file,source]=input.entries[0];const module=new SourceModule(file,source);
 const method=module.tokens.find(token=>token.value==='method');
 assert.equal(module.isCallableDeclarationToken(method),true);
 const reads=module.tokens.filter(token=>token.value==='read');
 assert.equal(reads.length,2);
 const binding=module.bindingAt(reads[0]);assert.ok(binding instanceof SourceInputBinding);
 assert.equal(module.bindingAt(reads[1]),binding);
});
const consumers=[
  {
    "name": "conditional-false / return read; / ordinary",
    "position": "conditional-false",
    "body": "return read;",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=(1===2)?{}:{method(read){return read;}};const result=selected.method(\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read; / native",
    "position": "conditional-false",
    "body": "return read;",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=(1===2)?{}:{method(read){return read;}};const result=selected.method(fs.readFileSync);opaque(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read(\"/proc/self/stat\"); / ordinary",
    "position": "conditional-false",
    "body": "return read(\"/proc/self/stat\");",
    "native": false,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=(1===2)?{}:{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(()=>\"ordinary\");console.log(result);"
      ]
    ]
  },
  {
    "name": "conditional-false / return read(\"/proc/self/stat\"); / native",
    "position": "conditional-false",
    "body": "return read(\"/proc/self/stat\");",
    "native": true,
    "entry": "src/consumer.mjs",
    "entries": [
      [
        "src/consumer.mjs",
        "import fs from 'node:fs';const selected=(1===2)?{}:{method(read){return read(\"/proc/self/stat\");}};const result=selected.method(fs.readFileSync);console.log(result);"
      ]
    ]
  }
];
for(const input of consumers)test(`actual conditional method input: ${input.name}`,()=>{
 const report=new OsIndependenceChecker(new MemorySourceRepository(input.entries),{files:[input.entry]}).check();
 if(!input.native){assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);}
 else{
  const direct=input.body.includes('/proc');const source=input.entries[0][1];const column=source.indexOf(direct?'read("/proc/self/stat")':'opaque(result)')+1;assert.ok(column>0);
  assert.ok(report.diagnostics.some(d=>d.file===input.entry&&d.rule==='OS01'&&d.line===1&&d.column===column&&d.classification===(direct?'violation':'incomplete')),report.diagnostics.join('\n'));
 }
});
for(const expression of [
 '(1===2) ? missing?.path : "/proc/self/stat"',
 '(1===2) ? missing ?? "ordinary" : "/proc/self/stat"',
 '(1===2) ? `?` : "/proc/self/stat"',
 '(1===2) ? `text${value ? "one" : "two"}` : "/proc/self/stat"',
 '(1===2) ? ({path:"ordinary"}).path : "/proc/self/stat"',
 '(1===2) ? ((1===1) ? "ordinary" : "other") : "/proc/self/stat"',
])test(`balanced conditional keeps the chosen I/O path: ${expression}`,()=>{
 const file='src/conditional.mjs';const source=`import fs from 'node:fs';fs.readFileSync(${expression});`;
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===1&&d.column===source.indexOf('fs.readFileSync')+1&&d.classification==='violation'),report.diagnostics.join('\n'));
});
for(const update of ['++','--'])test(`postfix ${update} before a block cannot declare its call`,()=>{
 const file='src/update-block.mjs';const source=`import fs from 'node:fs';const fn=fs.readFileSync;let count=0;count${update}\n{fn('/proc/self/stat')\n{}}`;
 const module=new SourceModule(file,source);const token=module.tokens.filter(t=>t.value==='fn').at(-1);
 assert.equal(module.isCallableDeclarationToken(token),false);
 assert.equal(module.bindingAt(token),module.moduleBinding('fn'));
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check();
 assert.ok(report.diagnostics.some(d=>d.file===file&&d.rule==='OS01'&&d.line===2&&d.column===2),report.diagnostics.join('\n'));
});
