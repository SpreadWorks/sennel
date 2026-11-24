import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const cases = [
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const input={};const map=factory.make(input);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    190
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return {file:\"ordinary\"};}}const factory=new Factory();const input={};const holder=factory.make(input);holder.file=\"/proc/self/stat\";fs.readFileSync(holder.file);",
    "OS01",
    185
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return [\"ordinary\"];}}const factory=new Factory();const input={};const holder=factory.make(input);holder[0]=\"/proc/self/stat\";fs.readFileSync(holder[0]);",
    "OS01",
    178
  ],
  [
    true,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const input={};const map=factory.make(input);const key={};map.set(key,\"ordinary\");opaque(map.get(key));",
    null,
    null
  ],
  [
    true,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const input={};const first=factory.make(input);const second=factory.make(input);const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null,
    null
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const input=[];const map=factory.make(input);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    190
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const map=factory.make(\"ordinary\");const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    180
  ],
  [
    true,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const factory=new Factory();const input={};function make(){return factory.make(input);}const first=make();const second=make();const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null,
    null
  ],
  [
    true,
    "import fs from 'node:fs';class Factory{make(input){return new WeakMap();}}const firstFactory=new Factory();const secondFactory=new Factory();const input={};const first=firstFactory.make(input);const second=secondFactory.make(input);const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null,
    null
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{make(input){return {read:input.read};}}const factory=new Factory();function make(input){return factory.make(input);}opaque(make({read:null}));opaque(make({read:fs.readFileSync}));",
    "OS02",
    182
  ],
  [
    false,
    "import fs from 'node:fs';class Factory{constructor(config){this.config=config;}make(input){return new WeakMap();}}const config={};const factory=new Factory(config);const input={};const map=factory.make(input);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    252
  ]
];
for (const [expectedOk, source, rule, column] of cases) {
  test(`method allocation retains inputs, writes and independent call sites: ${source}`, () => {
    const file = "src/method-input.mjs";
    const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
    assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [], report.diagnostics.join("\n"));
    assert.equal(report.ok, expectedOk, report.diagnostics.join("\n"));
    if (expectedOk) assert.equal(report.complete, true);
    else assert.equal(report.diagnostics.some(entry => entry.file === file && entry.rule === rule
      && entry.line === 1 && entry.column === column && entry.classification === "incomplete"), true,
      `expected ${rule} at the actual consumer 1:${column}\n${report.diagnostics.join("\n")}`);
  });
}
