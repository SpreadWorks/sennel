import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/regex-method.mjs';
const fixtures = [
  [
    "discarded-test",
    true,
    "/^ordinary$/.test('ordinary');",
    []
  ],
  [
    "bound-test",
    true,
    "const pattern=/^ordinary$/;console.log(pattern.test('ordinary'));",
    []
  ],
  [
    "bound-exec",
    true,
    "const pattern=/^ordinary$/;console.log(pattern.exec('ordinary'));",
    []
  ],
  [
    "repeat-global",
    true,
    "const r=/a/g;console.log(r.test('a'),r.test('a'));",
    []
  ],
  [
    "frozen-nonglobal",
    true,
    "const r=Object.freeze(/a/);console.log(r.test('a'));",
    []
  ],
  [
    "frozen-global",
    false,
    "const r=Object.freeze(/a/g);console.log(r.test('a'));",
    [
      [
        "OS02",
        1,
        41,
        "incomplete"
      ]
    ]
  ],
  [
    "frozen-sticky",
    false,
    "const r=Object.freeze(/a/y);console.log(r.exec('a'));",
    [
      [
        "OS02",
        1,
        41,
        "incomplete"
      ]
    ]
  ],
  [
    "sealed-global",
    true,
    "const r=Object.seal(/a/g);console.log(r.test('a'));",
    []
  ],
  [
    "lastindex-data",
    true,
    "const r=/a/g;r.test('a');console.log(r.lastIndex);",
    []
  ],
  [
    "detached",
    false,
    "const r=/a/;const test=r.test;test('a');",
    [
      [
        "OS02",
        1,
        31,
        "incomplete"
      ]
    ]
  ],
  [
    "borrowed",
    false,
    "const r=/a/;const holder={test:r.test};holder.test('a');",
    [
      [
        "OS02",
        1,
        40,
        "incomplete"
      ]
    ]
  ],
  [
    "new-test",
    false,
    "const r=/a/;new r.test('a');",
    [
      [
        "OS02",
        1,
        13,
        "incomplete"
      ]
    ]
  ],
  [
    "own-exec",
    false,
    "const r=/a/;r.exec=foreign;r.test('a');",
    [
      [
        "OS02",
        1,
        28,
        "incomplete"
      ]
    ]
  ],
  [
    "proto-exec",
    false,
    "RegExp.prototype.exec=foreign;const r=/a/;r.test('a');",
    [
      [
        "OS02",
        1,
        22,
        "incomplete"
      ],
      [
        "OS02",
        1,
        43,
        "incomplete"
      ]
    ]
  ],
  [
    "opaque",
    false,
    "const r=/a/;opaque(r);r.test('a');",
    [
      [
        "OS02",
        1,
        23,
        "incomplete"
      ]
    ]
  ],
  [
    "future-flag",
    false,
    "const r=/a/v;r.test('a');",
    [
      [
        "OS02",
        1,
        14,
        "incomplete"
      ]
    ]
  ],
  [
    "duplicate-flag",
    false,
    "const r=/a/gg;r.test('a');",
    [
      [
        "OS02",
        1,
        15,
        "incomplete"
      ]
    ]
  ],
  [
    "primitive-conversion",
    true,
    "const r=/a/;console.log(r.test(123),r.test(null),r.test());",
    []
  ],
  [
    "string-conversion",
    true,
    "const r=/a/;console.log(r.test(String(input)));",
    []
  ],
  [
    "object-conversion",
    false,
    "const r=/a/;r.test({toString(){return 'a';}});",
    [
      [
        "OS02",
        1,
        13,
        "incomplete"
      ],
      [
        "OS02",
        1,
        13,
        "incomplete"
      ]
    ]
  ],
  [
    "regex-conversion",
    false,
    "const r=/a/;r.test(/b/);",
    [
      [
        "OS02",
        1,
        13,
        "incomplete"
      ],
      [
        "OS02",
        1,
        13,
        "incomplete"
      ]
    ]
  ],
  [
    "weak-conversion",
    false,
    "const r=/a/;r.test(new WeakSet());",
    [
      [
        "OS02",
        1,
        13,
        "incomplete"
      ],
      [
        "OS02",
        1,
        13,
        "incomplete"
      ]
    ]
  ],
  [
    "extra-io",
    false,
    "import fs from 'node:fs';const r=/a/;r.test('a',fs.readFileSync('/proc/self/stat'));",
    [
      [
        "OS01",
        1,
        49,
        "violation"
      ]
    ]
  ],
  [
    "capture-fs",
    false,
    "import fs from 'node:fs';const r=/a/;const match=r.exec('prefix/proc/self/stat');fs.readFileSync(match[0]);",
    [
      [
        "OS01",
        1,
        82,
        "incomplete"
      ]
    ]
  ],
  [
    "input-fs",
    false,
    "import fs from 'node:fs';const r=/a/;const match=r.exec('/proc/self/stat');fs.readFileSync(match.input);",
    [
      [
        "OS01",
        1,
        76,
        "incomplete"
      ]
    ]
  ],
  [
    "input-data",
    true,
    "const r=/a/;const match=r.exec('ordinary');console.log(match.input);",
    []
  ],
  [
    "capture-data",
    true,
    "const r=/a/;const match=r.exec('ordinary');console.log(match[0]);",
    []
  ],
  [
    "capture-opaque",
    false,
    "const r=/a/;const match=r.exec('prefix/proc/self/stat');opaque(match[0]);",
    [
      [
        "OS02",
        1,
        57,
        "incomplete"
      ]
    ]
  ],
  [
    "result-native-field",
    false,
    "import fs from 'node:fs';const r=/a/;const match=r.exec('ordinary');match.read=fs.readFileSync;opaque(match.read);",
    [
      [
        "OS02",
        1,
        96,
        "incomplete"
      ],
      [
        "OS01",
        1,
        79,
        "incomplete"
      ]
    ]
  ],
  [
    "result-input-map",
    false,
    "import fs from 'node:fs';const r=/a/;const match=r.exec('ordinary');function wrap(input){return new WeakMap();}const map=wrap(match),key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    [
      [
        "OS02",
        1,
        170,
        "incomplete"
      ]
    ]
  ],
  [
    "regex-global-constructor",
    false,
    "globalThis.RegExp=foreign;const r=/a/;console.log(r.test('a'));",
    [
      [
        "OS02",
        1,
        18,
        "incomplete"
      ]
    ]
  ]
];
for (const [name, expected, source, sites] of fixtures) test(name, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.equal(report.ok, expected, JSON.stringify(report.diagnostics));
  if (expected) { assert.equal(report.complete, true); assert.deepEqual(report.diagnostics, []); }
  else for (const [rule, line, column, classification] of sites) assert.ok(report.diagnostics.some(entry =>
    entry.file === file && entry.rule === rule && entry.line === line && entry.column === column
      && entry.classification === classification), JSON.stringify(report.diagnostics));
});
