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
import * as nodeModule from "node:module";

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
    const configuration = JSON.parse(Buffer.from(options.env.NODE_OPTIONS.split('#').at(-1), 'base64url'));
    const original = fs.readFileSync(configuration.file, 'utf8');
    const payload = JSON.parse(original);
    const entry = payload.resources.find(entry => entry[0] === 'src/runtime-probe.js');
    entry[1] = (entry[1][0] === 'A' ? 'B' : 'A') + entry[1].slice(1);
    fs.writeFileSync(configuration.file, JSON.stringify(payload));
    const rejected = await new Promise((resolve, reject) => {
      const process = child.spawnNode('--input-type=module', ['-e', 'console.log("semantic execution")'], options);
      let stdout = '', stderr = '';
      process.stdout.on('data', bytes => { stdout += bytes; });
      process.stderr.on('data', bytes => { stderr += bytes; });
      process.once('error', reject);
      process.once('close', status => resolve({status, stdout, stderr}));
    });
    fs.writeFileSync(configuration.file, original);
    child.closeAfterExecution();
    let closed;
    try { child.options(); } catch(error) { closed = error.message; }
    console.log(JSON.stringify({status:rejected.status, stdout:rejected.stdout, stderr:rejected.stderr, closed}));
  `);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RUNTIME_DELIVERY_DIGEST_MISMATCH/);
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

test("runtime child delivery refuses an external scratch root and preserves its sentinel", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import path from 'node:path';
    import { RuntimeChildExecution } from './src/lib/runtime-package.js';
    const outside = path.resolve('external-scratch');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'external-owner');
    let code = null;
    let delivery;
    try { delivery = new RuntimeChildExecution({ root: process.cwd(), temporaryRoot: outside }); }
    catch (error) { code = error.code; }
    finally { delivery?.close(); }
    console.log(JSON.stringify({ code, entries: fs.readdirSync(outside), sentinel: fs.readFileSync(path.join(outside, 'sentinel'), 'utf8') }));
  `);
  assert.equal(result.code, "TEMPORARY_PATH_OUTSIDE_PROJECT");
  assert.deepEqual(result.entries, ["sentinel"]);
  assert.equal(result.sentinel, "external-owner");
});


test("runtime child canonicalizes inherited Node options and rejects duplicate aliases before writing delivery", (t) => {
  const root = fixture(t);
  const result = run(root, `
    import fs from 'node:fs';
    import { RuntimeChildExecution } from './src/lib/runtime-package.js';
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'));
    let duplicate;
    try { new RuntimeChildExecution({ environment: { ...inherited, NODE_OPTIONS: '', Node_Options: '--no-warnings' } }); }
    catch (error) { duplicate = error.code; }
    const wroteBeforeRejection = fs.existsSync('.tmp');
    const delivery = new RuntimeChildExecution({ environment: { ...inherited, Node_Options: '--no-warnings' } });
    const env = delivery.options().env;
    const keys = Object.keys(env).filter(key => key.toUpperCase() === 'NODE_OPTIONS');
    const workerOptions = delivery.workerOptions();
    const child = delivery.spawnNode('-e', ['process.stdout.write(process.env.NODE_OPTIONS)']);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    delivery.closeAfterExecution();
    console.log(JSON.stringify({ duplicate, wroteBeforeRejection, keys, workerOptions: workerOptions.env.NODE_OPTIONS, code, stdout, stderr }));
  `);
  assert.equal(result.duplicate, "COMMAND_INVOCATION_INVALID");
  assert.equal(result.wroteBeforeRejection, false);
  assert.deepEqual(result.keys, ["NODE_OPTIONS"]);
  assert.equal(result.workerOptions, "--no-warnings");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "--no-warnings");
});


for (const acknowledged of [false, true]) {
  test(`isolated capture refuses ${acknowledged ? "an acknowledged worker that never exits" : "a worker that never acknowledges"} within its finite startup window`,
    { skip: typeof nodeModule.registerHooks !== "function", timeout: 45000 }, (t) => {
      const root = fixture(t);
      const worker = path.join(root, "src/lib/runtime-capture-worker.js");
      fs.writeFileSync(worker, (acknowledged ? fs.readFileSync(worker, "utf8") : "") + "\nsetInterval(() => {}, 1000);\n");
      const result = spawnSync(process.execPath, ["--import", path.join(root, "src/sennel.js"), "-e", "console.log('semantic code must not run')"], {
        cwd: root, encoding: "utf8", timeout: 40000,
      });
      assert.equal(result.error, undefined, "bootstrap must return before the outer test deadline");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /RUNTIME_CAPTURE_EXIT_UNCONFIRMED/);
    });
}
