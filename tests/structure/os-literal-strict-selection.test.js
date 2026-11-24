import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/closed-input.mjs';
const fixtures=[
  [
    "strict-equal-ordinary",
    true,
    "import fs from 'node:fs';fs.readFileSync(0===0?'ordinary':'/proc/self/stat');",
    null
  ],
  [
    "strict-not-equal-ordinary",
    true,
    "import fs from 'node:fs';fs.readFileSync(0!==1?'ordinary':'/proc/self/stat');",
    null
  ],
  [
    "strict-different-type",
    false,
    "import fs from 'node:fs';fs.readFileSync(0==='0'?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      26,
      "violation"
    ]
  ],
  [
    "strict-false-ordinary",
    true,
    "import fs from 'node:fs';fs.readFileSync(0===1?'/proc/self/stat':'ordinary');",
    null
  ],
  [
    "strict-unknown",
    false,
    "import fs from 'node:fs';fs.readFileSync(input===0?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      26,
      "incomplete"
    ]
  ],
  [
    "strict-authority",
    false,
    "import fs from 'node:fs';fs.readFileSync(fs.statSync('ordinary').uid===0?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      26,
      "incomplete"
    ]
  ],
  [
    "strict-platform",
    false,
    "import fs from 'node:fs';fs.readFileSync(process.platform==='linux'?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      42,
      "violation"
    ]
  ],
  [
    "strict-getter-effects",
    false,
    "import fs from 'node:fs';const holder={get index(){fs.readFileSync('/proc/self/stat');return 0;}};fs.readFileSync(holder.index===0?'ordinary':'other');",
    [
      "OS01",
      1,
      52,
      "violation"
    ]
  ],
  [
    "strict-function-effects",
    false,
    "import fs from 'node:fs';function index(){fs.readFileSync('/proc/self/stat');return 0;}fs.readFileSync(index()===0?'ordinary':'other');",
    [
      "OS01",
      1,
      43,
      "violation"
    ]
  ],
  [
    "strict-object-no-coercion",
    false,
    "import fs from 'node:fs';const input={valueOf(){return 0;}};fs.readFileSync(input===0?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      61,
      "incomplete"
    ]
  ],
  [
    "coercive-equality-stays-unresolved",
    false,
    "import fs from 'node:fs';fs.readFileSync('0'==0?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      26,
      "incomplete"
    ]
  ],
  [
    "comparison-chain-stays-unresolved",
    false,
    "import fs from 'node:fs';fs.readFileSync(0===0===true?'ordinary':'/proc/self/stat');",
    [
      "OS01",
      1,
      26,
      "incomplete"
    ]
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
