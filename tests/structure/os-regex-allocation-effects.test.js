import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/regex-allocation.mjs';
const fixtures=[
  [
    "regex-input-map",
    false,
    "import fs from 'node:fs';const r=/a/;function wrap(input){return new WeakMap();}const map=wrap(r),key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      1,
      135,
      "incomplete"
    ]
  ],
  [
    "regex-key-map",
    false,
    "import fs from 'node:fs';const r=/a/;const map=new WeakMap();map.set(r,fs.readFileSync);opaque(map.get(r));",
    [
      "OS02",
      1,
      89,
      "incomplete"
    ]
  ],
  [
    "regex-late-field",
    false,
    "import fs from 'node:fs';const r=/a/;r.extra=fs.readFileSync;opaque(r);",
    [
      "OS02",
      1,
      62,
      "incomplete"
    ]
  ],
  [
    "regex-returned-field",
    false,
    "import fs from 'node:fs';function pack(input){return {item:input};}const box=pack(/a/);box.item.extra=fs.readFileSync;opaque(box.item);",
    [
      "OS02",
      1,
      119,
      "incomplete"
    ]
  ],
  [
    "regex-input-ordinary",
    true,
    "const r=/a/;function wrap(input){return new WeakMap();}const map=wrap(r),key={};map.set(key,'ordinary');opaque(map.get(key));",
    null
  ],
  [
    "regex-key-ordinary",
    true,
    "const r=/a/;const map=new WeakMap();map.set(r,'ordinary');opaque(map.get(r));",
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
