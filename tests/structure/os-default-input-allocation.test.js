import assert from "node:assert/strict";
import {test} from "node:test";
import {MemorySourceRepository} from "../support/structure/source-repository.js";
import {OsIndependenceChecker} from "../support/structure/os-independence-checker.js";
const cases = [
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input=process.env){return make(input);}const map=wrap(unknown);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      188
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return {file:'ordinary'};}function wrap(input='fallback'){return make(input);}const holder=wrap(unknown);holder.file='/proc/self/stat';fs.readFileSync(holder.file);",
    [
      "OS01",
      182
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const map=wrap(unknown);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      187
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const first=wrap(unknown);const second=wrap(unknown);const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const map=wrap(unknown);const key={};map.set(key,'ordinary');opaque(map.get(key));",
    null
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function inner(input='inner'){return make(input);}function outer(input='outer'){return inner(input);}const map=outer(unknown);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      237
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input={}){return make(input);}const map=wrap(unknown);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      179
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const map=wrap(undefined);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      189
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const map=wrap(null);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      "OS02",
      184
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return {read:input};}function wrap(input=fs.readFileSync){return make(input);}const selected=wrap(unknown);opaque(selected);",
    [
      "OS02",
      154
    ]
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const first=wrap(unknownA);const second=wrap(unknownB);const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}function wrap(input='fallback'){return make(input);}const map=wrap(unknown);const key={};map.set(key,fs.readFileSync);opaque(process.env);opaque(map.get(key));",
    [
      "OS02",
      207
    ]
  ]
];
for (const [source, consumer] of cases) {
  test(`default input retains supplied/fallback origins and returned allocations: ${source}`, () => {
    const file = "src/default-input-allocation.mjs";
    const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), {files: [file]}).check();
    assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [], report.diagnostics.join("\n"));
    if (consumer === null) { assert.equal(report.ok, true, report.diagnostics.join("\n")); assert.equal(report.complete, true); }
    else {
      assert.equal(report.ok, false);
      assert.equal(report.diagnostics.some(entry => entry.file === file && entry.rule === consumer[0]
        && entry.line === 1 && entry.column === consumer[1] && entry.classification === "incomplete"), true,
        `expected actual consumer ${consumer}\n${report.diagnostics.join("\n")}`);
    }
  });
}
