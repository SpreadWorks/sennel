import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
/**
 * Runtime proof outcomes: bootstrap owns capture -> loader evaluates captured
 * bytes -> identity/resource consumers observe that same set. Disk mutations
 * after ACK affect the next process only; pre-bootstrap references stay refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

function fixture(t) {
  const root = createTestDirectory("runtime-package-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repository, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(repository, "package.json"), path.join(root, "package.json"));
  fs.writeFileSync(path.join(root, "src/runtime-probe.js"), 'export const value = "captured";\n');
  fs.writeFileSync(path.join(root, "src/runtime-probe.json"), '{"value":"captured"}\n');
  return root;
}

function run(root, source, { bootstrap = true } = {}) {
  const result = spawnSync(process.execPath, [
    ...(bootstrap ? ["--import", path.join(root, "src/sennel.js")] : []),
    "--input-type=module", "-e", source,
  ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const identityScript = `
  import { currentRuntimePackage } from './src/lib/runtime-package.js';
  console.log(JSON.stringify(currentRuntimePackage().toJSON()));
`;

test("capture ACK binds identity, delayed source and JSON loads, schema and prompt reads while target edits remain live", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    import { currentRuntimePackage, readRuntimeResource } from './src/lib/runtime-package.js';
    const before = currentRuntimePackage().toJSON();
    const schemaPath = './src/flow/schemas/spec.schema.json';
    const promptPath = './src/flow/prompts/plan/spec.md';
    const originalSchema = readRuntimeResource(schemaPath);
    const localePath = './src/locale/en/ui.json';
    const originalLanguageNames = JSON.parse(readRuntimeResource(localePath)).languageNames;
    fs.unlinkSync(localePath);
    fs.unlinkSync('./src/presets/base/preset.json');
    const { getStepInstructions } = await import('./src/flow/lib/get-step-instructions.js');
    const originalPrompt = getStepInstructions('plan.spec');
    fs.writeFileSync('./src/runtime-probe.js', 'export const value = "edited";');
    fs.writeFileSync('./src/runtime-probe.json', '{"value":"edited"}');
    fs.writeFileSync(schemaPath, '{}');
    fs.writeFileSync(promptPath, 'edited prompt');
    const module = await import('./src/runtime-probe.js');
    const json = await import('./src/runtime-probe.json', { assert: { type: 'json' }, with: { type: 'json' } });
    const { loadSpecJsonSchema } = await import('./src/lib/spec-json.js');
    const { createI18n } = await import('./src/lib/i18n.js');
    const { CORE_PRESETS } = await import('./src/lib/presets.js');
    const source = readRuntimeResource('./src/runtime-probe.js');
    console.log(JSON.stringify({
      value: module.value, json: json.default.value,
      sameLocale: JSON.stringify(createI18n('en').raw('languageNames')) === JSON.stringify(originalLanguageNames),
      presets: CORE_PRESETS.map(preset => preset.key),
      samePrompt: getStepInstructions('plan.spec') === originalPrompt,
      sameSchema: JSON.stringify(loadSpecJsonSchema()) === JSON.stringify(JSON.parse(originalSchema)),
      revision: before.revision, after: currentRuntimePackage().revision,
      sourceDigest: crypto.createHash('sha256').update(source).digest('hex'),
      recordedDigest: before.files.find(file => file.key === 'src/runtime-probe.js').digest,
      liveTarget: fs.readFileSync('./src/runtime-probe.js', 'utf8'),
    }));
  `);
  assert.equal(result.value, "captured");
  assert.equal(result.json, "captured");
  assert.equal(result.sameSchema, true);
  assert.equal(result.samePrompt, true);
  assert.equal(result.sameLocale, true);
  assert.ok(result.presets.includes("base"));
  assert.equal(result.revision, result.after);
  assert.equal(result.sourceDigest, result.recordedDigest);
  assert.match(result.liveTarget, /edited/);
});

test("deleted captured module remains loadable and newly added package module is refused", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    fs.unlinkSync('./src/runtime-probe.js');
    fs.writeFileSync('./src/runtime-added.js', 'export const value = "new";');
    const module = await import('./src/runtime-probe.js');
    let error;
    try { await import('./src/runtime-added.js'); } catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ value: module.value, error }));
  `);
  assert.equal(result.value, "captured");
  assert.match(result.error, /RUNTIME_RESOURCE_UNAVAILABLE/);
});

test("same-version source/resource changes and file addition/deletion change the next process revision", (t) => {
  const root = fixture(t);
  let previous = run(root, identityScript).revision;
  fs.writeFileSync(path.join(root, 'target-source.js'), 'export const changed = true;');
  assert.equal(run(root, identityScript).revision, previous);
  const mutations = [
    () => fs.writeFileSync(path.join(root, 'src/runtime-probe.js'), 'export const value = "changed";'),
    () => fs.writeFileSync(path.join(root, 'src/runtime-probe.json'), '{"value":"changed"}'),
    () => fs.writeFileSync(path.join(root, 'src/runtime-added.js'), 'export default true;'),
    () => fs.renameSync(path.join(root, 'src/runtime-added.js'), path.join(root, 'src/runtime-added.js ')),
    () => fs.unlinkSync(path.join(root, 'src/runtime-added.js ')),
  ];
  for (const mutate of mutations) {
    mutate();
    const next = run(root, identityScript).revision;
    assert.notEqual(next, previous);
    previous = next;
  }
});

test("a reference evaluated before bootstrap cannot acquire runtime proof afterwards", (t) => {
  const root = fixture(t);
  const result = run(root, `
    const oldRuntime = await import('./src/lib/runtime-package.js');
    let before, after;
    try { oldRuntime.currentRuntimePackage(); } catch (error) { before = error.message; }
    await import('./src/sennel.js');
    try { oldRuntime.currentRuntimePackage(); } catch (error) { after = error.message; }
    const fixedRuntime = await import('./src/lib/runtime-package.js');
    console.log(JSON.stringify({ before, after, separate: fixedRuntime !== oldRuntime,
      revision: fixedRuntime.currentRuntimePackage().revision }));
  `, { bootstrap: false });
  assert.match(result.before, /RUNTIME_UNPROVEN/);
  assert.equal(result.after, result.before);
  assert.equal(result.separate, true);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
});

test("independent bootstrap checks the expected runtime and refuses a changed package before semantic evaluation", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { currentRuntimePackage } from './src/lib/runtime-package.js';
    const env = { ...process.env, NODE_OPTIONS: '--import=./src/sennel.js', SENNEL_RUNTIME_EXPECTED_REVISION: currentRuntimePackage().revision };
    const script = "import { currentRuntimePackage } from './src/lib/runtime-package.js'; console.log(currentRuntimePackage().revision)";
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    fs.writeFileSync('./src/runtime-probe.js', 'export const value = "changed";');
    const changed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    console.log(JSON.stringify({ same: first.status === 0 && first.stdout.trim() === currentRuntimePackage().revision,
      rejected: changed.status !== 0, semanticOutput: changed.stdout, error: changed.stderr }));
  `);
  assert.equal(result.same, true);
  assert.equal(result.rejected, true);
  assert.equal(result.semanticOutput, "");
  assert.match(result.error, /RUNTIME_REVISION_MISMATCH/);
});

test("direct child rejects corrupted delivered bytes and consumes no ambient runtime authority", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { RuntimeChildExecution } from './src/lib/runtime-package.js';
    const child = new RuntimeChildExecution();
    const options = child.options({encoding:'utf8'});
    const payload = JSON.parse(fs.readFileSync(options.stdio[3], 'utf8'));
    payload.resources.find(entry => entry[0] === 'src/runtime-probe.js')[1] = Buffer.from('export const value = "corrupted";').toString('base64');
    fs.writeFileSync('./corrupt-delivery.json', JSON.stringify(payload));
    const fd = fs.openSync('./corrupt-delivery.json', 'r');
    const rejected = spawnSync(process.execPath, ['--input-type=module','-e','console.log("semantic execution")'],
      {...options, stdio:['pipe','pipe','pipe',fd]});
    fs.closeSync(fd); child.close();
    let closed;
    try { child.options(); } catch(error) { closed = error.message; }
    console.log(JSON.stringify({status:rejected.status, stdout:rejected.stdout, stderr:rejected.stderr, closed}));
  `);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RUNTIME_REVISION_MISMATCH/);
  assert.match(result.closed, /closed/);
});

test("an inherited child reuses its completed bootstrap and can deliver the same runtime to its own child", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { currentRuntimePackage, RuntimeChildExecution } from './src/lib/runtime-package.js';
    fs.writeFileSync('./src/runtime-probe.js', 'export const value = "edited";');
    const script = "await import('./src/sennel.js'); const {currentRuntimePackage,RuntimeChildExecution}=await import('./src/lib/runtime-package.js'); const {value}=await import('./src/runtime-probe.js'); const {spawnSync}=await import('node:child_process'); const child=new RuntimeChildExecution(); const grandchild=spawnSync(process.execPath,['--input-type=module','-e',\\"import {currentRuntimePackage} from './src/lib/runtime-package.js';console.log(currentRuntimePackage().revision)\\"],child.options({encoding:'utf8'})); child.close(); console.log(JSON.stringify({revision:currentRuntimePackage().revision,value,grandchild:grandchild.stdout.trim(),status:grandchild.status,error:grandchild.stderr}));";
    const child = new RuntimeChildExecution();
    const nested = spawnSync(process.execPath, ['--input-type=module','-e',script], child.options({encoding:'utf8'}));
    child.close();
    console.log(JSON.stringify({parent:currentRuntimePackage().revision,status:nested.status,stdout:nested.stdout,error:nested.stderr}));
  `);
  assert.equal(result.status, 0, result.error);
  const child = JSON.parse(result.stdout);
  assert.equal(child.revision, result.parent);
  assert.equal(child.value, "captured");
  assert.equal(child.status, 0, child.error);
  assert.equal(child.grandchild, result.parent);
});
