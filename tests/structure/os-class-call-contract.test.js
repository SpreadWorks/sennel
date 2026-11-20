import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/class-call-probe.js';
const api = fs.readFileSync(new URL('../../src/lib/command-invocation.js', import.meta.url), 'utf8');
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, source], ['src/command-invocation.js', api],
  ]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}

for (const constructed of [false, true]) {
  test(`actual invocation class requires construction: new=${constructed}`, () => {
    const source = `import {spawn} from 'node:child_process';
import {NativeExecutableInvocation} from './command-invocation.js';
const invocation = ${constructed ? 'new ' : ''}NativeExecutableInvocation({executable:process.execPath,args:['worker.js'],cwd:null,env:null,stdio:'ignore'});
spawn(invocation.executable,invocation.args,{...invocation.processOptions(),shell:false});`;
    const report = inspect(source);
    const findings = report.diagnostics.filter(entry => entry.file === file && entry.line === 4);
    if (constructed) assert.deepEqual(findings, [], report.diagnostics.join('\n'));
    else {
      assert.equal(report.ok, false);
      assert.ok(findings.some(entry => entry.rule === 'OS02'), report.diagnostics.join('\n'));
    }
  });
}

for (const source of [
  'class Reader {} Reader();',
  'class Reader {} const instance = new Reader(); instance();',
  'class Reader {} const instance = new Reader(); new instance();',
]) test(`non-callable source class values refuse normal completion: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.classification === 'incomplete'), report.diagnostics.join('\n'));
});

test('native Error retains its callable contract without new', () => {
  const report = inspect("import fs from 'node:fs'; fs.readFileSync(Error('ordinary.json').message);");
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});

for (const ordinary of [false, true]) test(`new without argument parentheses constructs the actual receiver: ordinary=${ordinary}`, () => {
  const source = `import fs from 'node:fs'; class Reader { file='${ordinary ? 'ordinary.json' : '/proc/self/stat'}'; read(){fs.readFileSync(this.file);} } const instance=new Reader; instance.read();`;
  const report = inspect(source);
  assert.equal(report.ok, ordinary, report.diagnostics.join('\n'));
  if (ordinary) assert.equal(report.complete, true);
  else assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === 'OS01' && entry.classification === 'violation'), report.diagnostics.join('\n'));
});
