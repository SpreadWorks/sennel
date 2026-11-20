import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
import { SourceModule } from '../support/structure/source-reader.js';
const file = 'src/signature.mjs';
const cases = [
  {
    "name": "normal",
    "source": "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}const value=new Failure('ordinary');console.log(value.message);",
    "normal": true
  },
  {
    "name": "separate normal input",
    "source": "import fs from 'node:fs';class Failure extends TypeError{constructor(message,{source='ordinary'}={}){super(`${source}: ${message}`);this.source=source;}}function make(message){return new Failure(message);}const a=make('first'),b=make('second');console.log(a.message,b.message);",
    "normal": true
  },
  {
    "name": "production-class",
    "source": "/** Literal process arguments. Display text never grants execution authority. */\nexport class CommandInvocationError extends TypeError {\n  constructor(message, { source = 'command', language = 'en' } = {}) {\n    const help = language === 'ja'\n      ? 'シェル文字列を廃止しました。例: {\"kind\":\"node-script\",\"script\":\"tests/run.js\",\"args\":[]}。実行ファイルには {\"kind\":\"native\",\"executable\":\"tool\",\"args\":[]} を使い、各引数を配列要素として指定してください。'\n      : 'Replace shell text explicitly, for example {\"kind\":\"node-script\",\"script\":\"tests/run.js\",\"args\":[]} or {\"kind\":\"native\",\"executable\":\"tool\",\"args\":[]}; put each literal argument in its own array element.';\n    super(`${source}: ${message}. ${help}`);\n    this.code = 'COMMAND_INVOCATION_INVALID';\n    this.source = source;\n  }\n}",
    "normal": true
  },
  {
    "name": "renamed",
    "source": "class Changed{renamed({field=\"data\"}={}){return field;}}",
    "normal": true
  },
  {
    "name": "accessor",
    "source": "class Changed{get label(){return \"ordinary\";} set label({field=\"data\"}){}}",
    "normal": true
  },
  {
    "name": "async",
    "source": "class Changed{async renamed({field=\"data\"}={}){return field;}}",
    "normal": true
  },
  {
    "name": "generator",
    "source": "class Changed{*renamed({field=\"data\"}={}){}}",
    "normal": true
  },
  {
    "name": "async-generator",
    "source": "class Changed{async *renamed({field=\"data\"}={}){}}",
    "normal": true
  },
  {
    "name": "default-io",
    "source": "import fs from 'node:fs';class Changed{constructor({field=fs.readFileSync('/proc/self/stat')}={}){}} new Changed();",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "computed-io",
    "source": "import fs from 'node:fs';class Changed{[fs.readFileSync('/proc/self/stat')](){return 'ordinary';}}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "body-io",
    "source": "import fs from 'node:fs';class Changed{constructor({field='data'}={}){fs.readFileSync('/proc/self/stat');}} new Changed();",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "method-body-io",
    "source": "import fs from 'node:fs';class Changed{renamed({field='data'}={}){fs.readFileSync('/proc/self/stat');}}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "accessor-body-io",
    "source": "import fs from 'node:fs';class Changed{get label(){return fs.readFileSync('/proc/self/stat');}}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "async-body-io",
    "source": "import fs from 'node:fs';class Changed{async renamed(){return fs.readFileSync('/proc/self/stat');}}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "generator-body-io",
    "source": "import fs from 'node:fs';class Changed{*renamed(){fs.readFileSync('/proc/self/stat');}}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "call-before-block",
    "source": "import fs from 'node:fs';const fn=fs.readFileSync;fn('/proc/self/stat')\n{}",
    "normal": false,
    "effect": "fn('/proc/self/stat')"
  },
  {
    "name": "member-call-before-block",
    "source": "import fs from 'node:fs';fs.readFileSync('/proc/self/stat')\n{}",
    "normal": false,
    "effect": "fs.readFileSync('/proc/self/stat')"
  },
  {
    "name": "default-call-before-block",
    "source": "import fs from 'node:fs';function fn(file='/proc/self/stat'){fs.readFileSync(file);}fn()\n{}",
    "normal": false,
    "effect": "fs.readFileSync(file)"
  }
];
for (const input of cases) test(`callable signature boundary: ${input.name}`, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, input.source]]), { files: [file] }).check();
  if (input.normal) {
    assert.equal(report.ok, true, report.diagnostics.join('\n'));
    assert.equal(report.complete, true);
    assert.deepEqual(report.diagnostics, []);
  } else {
    const offset = input.source.indexOf(input.effect);
    assert.ok(offset >= 0);
    const prefix = input.source.slice(0, offset).split('\n');
    assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === 'OS01'
      && entry.line === prefix.length && entry.column === prefix.at(-1).length + 1), report.diagnostics.join('\n'));
  }
});
test('reader projects only owned callable declaration names, including duplicate methods', () => {
  const module = new SourceModule(file, 'class Renamed { field=1; method(){} method(){} get access(){return 1;} static other(){} }');
  assert.deepEqual(module.tokens.filter(token => module.isCallableDeclarationToken(token)).map(token => token.value),
    ['method', 'method', 'get', 'access', 'static', 'other']);
});
test('reader distinguishes callable names from actual calls before a separate block', () => {
  const module = new SourceModule(file, 'function named(){} const value=function expression(){}; named()\n{}');
  assert.deepEqual(module.tokens.filter(token => module.isCallableDeclarationToken(token)).map(token => token.value), ['named', 'expression']);
  assert.equal(module.isCallableDeclarationToken(module.tokens.filter(token => token.value === 'named').at(-1)), false);
});
test('declaration name projection requires the same source token identity', () => {
  const module = new SourceModule(file, 'class Renamed { method(){} }');
  const foreign = new SourceModule(file, 'class Renamed { method(){} }');
  assert.equal(module.isCallableDeclarationToken(foreign.tokens.find(token => token.value === 'method')), false);
});
