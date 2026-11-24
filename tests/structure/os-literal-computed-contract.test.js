import assert from "node:assert/strict";
import {test} from "node:test";
import {MemorySourceRepository} from "../support/structure/source-repository.js";
import {OsIndependenceChecker} from "../support/structure/os-independence-checker.js";
const file="src/literal-member-controls.mjs";
const cases=[
  [
    "unknown member",
    "import fs from 'node:fs'; fs[unknownKey](file);",
    "OS01",
    29,
    "incomplete"
  ],
  [
    "actual proc",
    "import fs from 'node:fs'; fs['readFileSync']('/proc/self/stat');",
    "OS01",
    27,
    "violation"
  ],
  [
    "changed native identity",
    "import fs from 'node:fs'; fs.readFileSync=foreign; fs['readFileSync'](file);",
    "OS02",
    52,
    "incomplete"
  ],
  [
    "extra argument getter",
    "import fs from 'node:fs'; const extra={get value(){fs.readFileSync('/proc/self/stat');return 'utf8';}};fs['readFileSync']('ordinary',extra.value);",
    "OS01",
    52,
    "violation"
  ]
];
for(const [name,source,rule,column,classification] of cases)test(`literal computed native controls preserve actual effects: ${name}`,()=>{
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file],entrypoints:[file]}).check();
 assert.equal(report.ok,false);
 assert.equal(report.complete,classification==='violation');
 assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[]);
 const diagnostic=report.diagnostics.find(entry=>entry.rule===rule&&entry.file===file&&entry.line===1&&entry.column===column&&entry.classification===classification);
 assert.ok(diagnostic,report.diagnostics.join('\n'));
 assert.deepEqual(diagnostic.trace,[file]);
});
