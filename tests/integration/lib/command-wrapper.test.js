import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { testTemporaryRoot } from '../../test-environment.js';
import { runCommandWrapper } from '../../../src/command.js';
import { ProcessExecutionRuntime } from '../../../src/lib/process-execution-runtime.js';
import { ProcessExecutionBinding, ProcessExecutionStopReceipt } from '../../../src/lib/process-execution-values.js';
import { executeManagedProcess } from '../../../src/lib/managed-process.js';
import { CommandInvocation, NodeScriptInvocation } from '../../../src/lib/command-invocation.js';
import { ManagedResponsePublicationGate } from '../../support/infrastructure/managed-response-publication-gate.js';

const sourceEntry = fileURLToPath(new URL('../../../src/sennel.js', import.meta.url));

async function closeFixture(runtime, root) {
  try { await runtime?.close(); }
  catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
  fs.rmSync(root, { recursive: true, force: true });
}

test('public wrapper requires explicit separator and authenticated inherited context', async () => {
  await assert.rejects(runCommandWrapper(['node', '--version'], { environment: {}, stdin: Readable.from([]) }), { code: 'COMMAND_ARGUMENTS_INVALID' });
  await assert.rejects(runCommandWrapper(['--', 'node', '--version'], { environment: {}, stdin: Readable.from([]) }), { code: 'COMMAND_CONTEXT_REQUIRED' });
  await assert.rejects(runCommandWrapper(['--', 'node'], { environment: { SENNEL_PROCESS_EXECUTION_SCOPE: '{}' }, stdin: Readable.from([]) }), { code: 'COMMAND_CONTEXT_INVALID' });
});

test('authenticated CLI uses parent pinned loader and preserves argv stdin stdout stderr and normal nonzero exit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-wrapper-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const entry = path.join(root, 'src', 'sennel.js');
  fs.copyFileSync(sourceEntry, entry);
  const marker = path.join(root, 'mutable-loader-executed');
  fs.writeFileSync(path.join(root, 'src', 'lib', 'runtime-loader.js'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');throw new Error('mutable loader');`);
  const target = path.join(root, 'target.cjs');
  fs.writeFileSync(target, `let chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:Buffer.concat(chunks).toString()}));process.stderr.write('exact stderr');process.exitCode=7;});`);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, binding: null, environment: {} });
  const literalArgs = ['', 'two words', '"quoted"', 'C:\\path\\last\\', '日本語', '$HOME&value', '%PATH%', '`literal`'];
  const invocation = new NodeScriptInvocation({ script: entry,
    args: ['command', '--', process.execPath, target, ...literalArgs], cwd: root });
  const invocationFile = path.join(root, 'invocation.json');
  fs.writeFileSync(invocationFile, JSON.stringify(invocation));
  const restored = CommandInvocation.fromStored(JSON.parse(fs.readFileSync(invocationFile, 'utf8')));
  let result;
  try { result = await runtime.enter(() => executeManagedProcess(restored, [], { runtime, stdinContent: 'input\nbytes', timeoutMs: 30000 })); }
  catch (error) {
    const states = runtime.store.read().executions.at(-1).calls.map(({ status, accepting, observation, stopOperation }) => ({ status, accepting, observation, stopOperation }));
    error.message += '\nRegistered execution state: ' + JSON.stringify(states) + '\nChild stderr: ' + (error.stderr ?? '');
    throw error;
  }
  const admissionStates = runtime.store.read().executions.at(-1).calls.map(({ status, accepting, observation, stopOperation }) => ({ status, accepting, observation, stopOperation }));
  assert.equal(result.code, 7, result.stderr + JSON.stringify(admissionStates));
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { args: literalArgs, input: 'input\nbytes' });
  assert.equal(result.stderr, 'exact stderr');
  assert.equal(fs.existsSync(marker), false);
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parentCallId, calls[0].callId);
  assert.deepEqual(CommandInvocation.fromStored(calls[0].invocation.actualCommand).scriptArgs,
    ['command', '--', process.execPath, target, ...literalArgs]);
  assert.deepEqual(CommandInvocation.fromStored(calls[1].invocation.actualCommand).args,
    [target, ...literalArgs]);
  assert.ok(calls.every((call) => call.receipt !== null));
});

test('public wrapper preserves a normal target exit when the target deliberately closes its input pipe', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-closed-input-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const target = path.join(root, 'closed-input.cjs');
  // A utility may finish reading before its caller finishes writing. Keep the
  // owned target alive briefly after closing fd 0 so actual pipe-error handling
  // is observable; it still has its ordinary finite exit and exact output.
  fs.writeFileSync(target, `require('node:fs').closeSync(0);process.stdout.write('normal closed-input output');process.stderr.write('normal closed-input error');setTimeout(()=>{process.exitCode=0;},500);`);
  const input = Buffer.alloc(8 * 1024 * 1024, 97);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: entry,
    args: ['command', '--', process.execPath, target], cwd: root }), [], {
    runtime, stdinContent: input, timeoutMs: 30000,
  }));
  const calls = runtime.store.read().executions.at(-1).calls;
  const child = calls.find((call) => call.parentCallId !== null);
  t.diagnostic(JSON.stringify({ inputBytes: input.length, wrapperCode: result.code,
    targetCallId: child?.callId ?? null, targetCode: child?.observation?.code ?? null,
    targetSignal: child?.observation?.signal ?? null, stdinError: child?.outcome?.stdinError ?? null,
    stopReason: child?.stopOperation?.reason ?? null }));
  assert.equal(calls.length, 2);
  assert.equal(child.parentCallId, calls[0].callId);
  assert.equal(typeof child.outcome?.stdinError, 'string', 'the real target must cause a pipe write error');
  assert.ok(child.outcome.stdinError.length > 0);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'normal closed-input output');
  assert.equal(result.stderr, 'normal closed-input error');
  const receipt = new ProcessExecutionStopReceipt(child.receipt);
  assert.equal(receipt.observation.code, 0);
  assert.equal(receipt.observation.signal, null);
  assert.equal(receipt.output.completion, 'complete');
  assert.equal(receipt.stopOperation, null, 'a normal utility input close must not create a stop decision');
  assert.ok(calls.every((call) => call.receipt !== null));
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root });
  assert.equal(saved.executions[0].status, 'closed');
  assert.equal(saved.executions[0].calls.length, 2);
  const historical = saved.executions[0].calls.find((call) => call.callId === child.callId);
  assert.deepEqual(historical.receipt, receipt.toJSON());
  assert.equal(historical.outcome.stdinError, child.outcome.stdinError);
});


for (const bindingKind of ['refined', 'null']) {
test(`public wrapper preserves its registered parent call's ${bindingKind} binding instead of the enclosing scope`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-binding-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const effect = path.join(root, 'target-effect.txt');
  const target = path.join(root, 'target.cjs');
  fs.writeFileSync(target, `require('node:fs').writeFileSync(process.argv[2], 'exact child effect');process.stdout.write('refined binding accepted');`);
  const scopeBinding = new ProcessExecutionBinding({ runId: 'wrapper-binding-run', specId: 'wrapper-binding-spec', commandId: 'dispatch' });
  const parentBinding = new ProcessExecutionBinding(bindingKind === 'null' ? null : {
    ...scopeBinding.toJSON(), commandId: 'worker', executionContractId: 'worker-contract',
    executionGeneration: 2, dispatchInvocationId: 'worker-dispatch',
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {},
    runId: 'wrapper-binding-run', specId: 'wrapper-binding-spec', binding: scopeBinding });
  const invoke = (scope) => executeManagedProcess(new NodeScriptInvocation({ script: entry,
    args: ['command', '--', process.execPath, target, effect], cwd: root }), [], {
    runtime: scope, processExecutionBinding: parentBinding, timeoutMs: 30000,
  });
  const result = bindingKind === 'null'
    ? await runtime.withBinding(null, () => invoke(ProcessExecutionRuntime.current()))
    : await runtime.enter(() => invoke(runtime));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'refined binding accepted');
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(effect, 'utf8'), 'exact child effect');
  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root }).inventory;
  const saved = inventory.executions.find((execution) => execution.executionId === runtime.executionId);
  assert.equal(saved.status, 'closed');
  assert.ok(new ProcessExecutionBinding(saved.binding).matches(scopeBinding));
  assert.equal(saved.calls.length, 2);
  assert.equal(saved.calls[1].parentCallId, saved.calls[0].callId);
  for (const call of saved.calls) {
    const receipt = new ProcessExecutionStopReceipt(call.receipt);
    assert.ok(new ProcessExecutionBinding(call.binding).matches(parentBinding));
    assert.ok(receipt.binding.matches(parentBinding));
    assert.equal(receipt.stopEvidence.confirmed, true);
  }
});
}

test('forged inherited mailbox outside coordinator namespace writes no request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-forged-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  const requests = path.join(root, 'unrelated-requests');
  const responses = path.join(root, 'unrelated-responses');
  fs.mkdirSync(requests); fs.mkdirSync(responses);
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const driver = path.join(root, 'driver.mjs');
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, environment: {} });
  const grant = runtime.remoteGrant();
  const forged = { ...grant, endpoint: { ...grant.endpoint, mailbox: { requests, responses } } };
  fs.writeFileSync(driver, `process.env.SENNEL_PROCESS_EXECUTION_SCOPE=${JSON.stringify(JSON.stringify(forged))};process.argv=[process.execPath,${JSON.stringify(entry)},'command','--',process.execPath,'--version'];await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: driver, cwd: root }), [], { runtime, timeoutMs: 60000 }));
  assert.equal(result.code, 125);
  assert.match(result.stderr, /outside its coordinator namespace/);
  assert.deepEqual(fs.readdirSync(requests), []);
  assert.deepEqual(fs.readdirSync(responses), []);
});

test('readonly wrapper authenticates over the real coordinator socket without attempting mailbox writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-readonly-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const input = path.join(root, 'authority.txt');
  fs.writeFileSync(input, 'complete readonly input 日本語');
  const driver = path.join(root, 'readonly-driver.mjs');
  fs.writeFileSync(driver, `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import assert from 'node:assert/strict';
    const open=fs.openSync;
    let writes=0;
    const refuse=()=>{writes++;throw Object.assign(new Error('readonly wrapper filesystem'),{code:'EROFS'})};
    fs.openSync=(file,flags,...args)=>{if(flags!=='r'&&flags!==0)refuse();return open(file,flags,...args)};
    for(const name of ['writeFileSync','appendFileSync','renameSync','unlinkSync','mkdirSync'])fs[name]=refuse;
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(entry)},'command','--',process.execPath,'-e',
      'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',${JSON.stringify(input)}];
    await import(${JSON.stringify(pathToFileURL(entry).href)});
    assert.equal(writes,0,'wrapper must not attempt a filesystem write when TCP is available');
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  assert.notEqual(runtime.remoteGrant().endpoint.port, null, 'readonly socket fixture requires the actual coordinator TCP endpoint');
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: driver, cwd: root }), [], {
    runtime, timeoutMs: 30000,
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'complete readonly input 日本語');
  assert.equal(result.stderr, '');
  const calls = runtime.store.read().executions.at(-1).calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parentCallId, calls[0].callId);
  assert.ok(calls.every((call) => call.receipt?.stopEvidence.confirmed));
});

test('readonly wrapper reports both the denied connection and mailbox publication without launching its target', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-transport-refusal-'));
  let runtime;
  t.after(() => closeFixture(runtime, root));
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const driver = path.join(root, 'driver.mjs');
  const effect = path.join(root, 'target-effect');
  fs.writeFileSync(driver, `
    import fs from 'node:fs';
    import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    const grant=JSON.parse(process.env.SENNEL_PROCESS_EXECUTION_SCOPE);
    const connect=net.createConnection;
    net.createConnection=function(options,...args){
      if(options?.port!==grant.endpoint.port)return connect.call(this,options,...args);
      const socket=new net.Socket();
      queueMicrotask(()=>socket.emit('error',Object.assign(new Error('connection denied'),{code:'EPERM',syscall:'connect'})));
      return socket;
    };
    const open=fs.openSync;
    fs.openSync=function(file,flags,...args){
      if(typeof file==='string'&&file.startsWith(grant.endpoint.mailbox.requests+${JSON.stringify(path.sep)})&&flags==='wx'){
        throw Object.assign(new Error('mailbox is read only'),{code:'EROFS',syscall:'open'});
      }
      return open.call(this,file,flags,...args);
    };
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(entry)},'command','--',process.execPath,'-e',
      'require("node:fs").writeFileSync(process.argv[1],"unexpected target")',${JSON.stringify(effect)}];
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  assert.notEqual(runtime.remoteGrant().endpoint.port, null);
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: driver, cwd: root }), [], {
    runtime, timeoutMs: 30000,
  }));
  assert.equal(result.code, 125);
  assert.match(result.stderr, /EPERM/);
  assert.match(result.stderr, /EROFS/);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(effect), false);
  await runtime.close();
  const saved = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root }).inventory;
  const execution = saved.executions.find((item) => item.executionId === runtime.executionId);
  assert.equal(execution.status, 'closed');
  assert.equal(execution.calls.length, 1, 'transport refusal must precede target admission');
  const receipt = new ProcessExecutionStopReceipt(execution.calls[0].receipt);
  assert.equal(receipt.observation.code, 125);
  assert.equal(receipt.stopEvidence.confirmed, true);
});

test('public wrapper waits for its owned code-proof response to finish exclusive publication before executing the target', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-publication-'));
  const gate = new ManagedResponsePublicationGate(root, { operation: 'runtime-snapshot' });
  let runtime;
  t.after(async () => { gate.release(); await closeFixture(runtime, root); });
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const observed = path.join(root, 'observed-response-links.json');
  const effect = path.join(root, 'target-effect.txt');
  const target = path.join(root, 'target.cjs');
  fs.writeFileSync(target, `require('node:fs').writeFileSync(process.argv[2], 'published proof');process.stdout.write('target after proof');`);
  const driver = path.join(root, 'publication-driver.mjs');
  fs.writeFileSync(driver, `
    import fs from 'node:fs';import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const grant=JSON.parse(process.env.SENNEL_PROCESS_EXECUTION_SCOPE);
    process.env.SENNEL_PROCESS_EXECUTION_SCOPE=JSON.stringify({...grant,transport:'mailbox'});
    const lstat=fs.lstatSync;let observed=false;
    fs.lstatSync=function(file,...options){
      const stat=lstat.call(this,file,...options);
      if(!observed&&path.dirname(String(file))===grant.endpoint.mailbox.responses
        &&String(file).endsWith('.json')&&BigInt(stat.nlink)>1n){
        observed=true;
        fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({links:Number(stat.nlink),responsePath:String(file)}));
        fs.writeFileSync(${JSON.stringify(gate.releasePath)},'release');
      }
      return stat;
    };
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(entry)},'command','--',process.execPath,${JSON.stringify(target)},${JSON.stringify(effect)}];
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: gate.coordinatorEnvironment() });
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: driver, cwd: root }), [], {
    runtime, timeoutMs: 30000,
  }));
  assert.equal(gate.observedLinks(), 2);
  const observation = JSON.parse(fs.readFileSync(observed, 'utf8'));
  assert.equal(observation.links, 2);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'target after proof');
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(effect, 'utf8'), 'published proof');
  assert.equal(fs.statSync(observation.responsePath).nlink, 1);
  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root }).inventory;
  const saved = inventory.executions.find((execution) => execution.executionId === runtime.executionId);
  assert.equal(saved.status, 'closed');
  assert.equal(saved.calls.length, 2);
  assert.equal(saved.calls[1].parentCallId, saved.calls[0].callId);
  for (const call of saved.calls) assert.equal(new ProcessExecutionStopReceipt(call.receipt).stopEvidence.confirmed, true);
});

test('public wrapper refuses a persistent foreign code-proof response link at its unchanged deadline without executing the target', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-foreign-link-'));
  const alias = path.join(root, 'fixture-response-alias');
  let runtime;
  t.after(async () => {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    await closeFixture(runtime, root);
  });
  const entry = path.join(root, 'entry.mjs');
  fs.copyFileSync(sourceEntry, entry);
  const observed = path.join(root, 'response-observation.json');
  const originalBytes = path.join(root, 'original-response.bin');
  const elapsed = path.join(root, 'elapsed.json');
  const effect = path.join(root, 'target-effect.txt');
  const target = path.join(root, 'target.cjs');
  fs.writeFileSync(target, `require('node:fs').writeFileSync(process.argv[2], 'must not execute');`);
  const driver = path.join(root, 'foreign-link-driver.mjs');
  fs.writeFileSync(driver, `
    import fs from 'node:fs';import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const grant=JSON.parse(process.env.SENNEL_PROCESS_EXECUTION_SCOPE);
    process.env.SENNEL_PROCESS_EXECUTION_SCOPE=JSON.stringify({...grant,transport:'mailbox'});
    const lstat=fs.lstatSync;let linked=false;
    fs.lstatSync=function(file,...options){
      const stat=lstat.call(this,file,...options);
      if(!linked&&path.dirname(String(file))===grant.endpoint.mailbox.responses
        &&String(file).endsWith('.json')&&BigInt(stat.nlink)===1n){
        const bytes=fs.readFileSync(file);
        const frame=JSON.parse(bytes);
        if(frame.operation==='runtime-snapshot'){
          linked=true;
          fs.writeFileSync(${JSON.stringify(originalBytes)},bytes);
          fs.linkSync(file,${JSON.stringify(alias)});
          const aliased=lstat.call(this,file,...options);
          fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({
            beforeLinks:Number(stat.nlink),afterLinks:Number(aliased.nlink),responsePath:String(file),
            responseOk:frame.payload.ok,deadlines:grant.controlResponseDeadlinesMs}));
          return aliased;
        }
      }
      return stat;
    };
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(entry)},'command','--',process.execPath,${JSON.stringify(target)},${JSON.stringify(effect)}];
    const started=performance.now();
    await import(${JSON.stringify(pathToFileURL(entry).href)});
    fs.writeFileSync(${JSON.stringify(elapsed)},JSON.stringify(performance.now()-started));
  `);
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
  const result = await runtime.enter(() => executeManagedProcess(new NodeScriptInvocation({ script: driver, cwd: root }), [], {
    runtime, timeoutMs: 30000,
  }));
  assert.equal(result.code, 125, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /COMMAND_BOOTSTRAP_RESPONSE_PUBLICATION_PENDING: Inherited mailbox response is still multiply linked/);
  assert.equal(fs.existsSync(effect), false);
  const observation = JSON.parse(fs.readFileSync(observed, 'utf8'));
  assert.equal(observation.beforeLinks, 1);
  assert.equal(observation.afterLinks, 2);
  assert.equal(observation.responseOk, true);
  assert.deepEqual(observation.deadlines, [2000, 6000, 14000]);
  assert.ok(JSON.parse(fs.readFileSync(elapsed, 'utf8')) >= observation.deadlines.at(-1));
  assert.equal(fs.statSync(observation.responsePath).nlink, 2);
  assert.deepEqual(fs.readFileSync(observation.responsePath), fs.readFileSync(originalBytes));
  fs.unlinkSync(alias);
  assert.equal(fs.statSync(observation.responsePath).nlink, 1);
  await runtime.close();
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: root, executionRoot: root }).inventory;
  const saved = inventory.executions.find((execution) => execution.executionId === runtime.executionId);
  assert.equal(saved.status, 'closed');
  assert.equal(saved.calls.length, 1);
  assert.equal(saved.calls[0].parentCallId, null);
  const receipt = new ProcessExecutionStopReceipt(saved.calls[0].receipt);
  assert.equal(receipt.observation.kind, 'exited');
  assert.equal(receipt.observation.code, 125);
  assert.equal(receipt.stopEvidence.confirmed, true);
});


class RuntimeWireDeliveryFault {
  constructor(name, mutation, explanation) {
    this.name = name;
    this.mutation = mutation;
    this.explanation = explanation;
    Object.freeze(this);
  }
}

for (const fault of [
  new RuntimeWireDeliveryFault('noncanonical base64',
    `envelope.body+='!';`, 'base64 is invalid'),
  new RuntimeWireDeliveryFault('an unknown envelope field',
    `envelope.unexpected=true;`, 'envelope is invalid'),
  new RuntimeWireDeliveryFault('truncated gzip',
    `envelope.body=Buffer.from(envelope.body,'base64').subarray(0,-1).toString('base64');`, 'decompression failed'),
  new RuntimeWireDeliveryFault('malformed gzip',
    `envelope.body=Buffer.from([0,1,2]).toString('base64');`, 'decompression failed'),
  new RuntimeWireDeliveryFault('wrong decoded digest',
    `envelope.digest=envelope.digest[0]==='0'?'1'+envelope.digest.slice(1):'0'+envelope.digest.slice(1);`, 'bytes differ from their envelope'),
  new RuntimeWireDeliveryFault('wrong decoded length',
    `envelope.decodedByteLength++;`, 'bytes differ from their envelope'),
  new RuntimeWireDeliveryFault('wrong revision',
    `envelope.revision=envelope.revision[0]==='0'?'1'+envelope.revision.slice(1):'0'+envelope.revision.slice(1);`, 'envelope is invalid'),
  new RuntimeWireDeliveryFault('declared decoded size beyond the wire delivery bound',
    `envelope.decodedByteLength=32*1024*1024+1;`, 'envelope is invalid'),
  new RuntimeWireDeliveryFault('gzip expansion beyond its declared bound',
    `const expanded=Buffer.alloc(32*1024*1024+1,32);envelope.body=gzipSync(expanded).toString('base64');envelope.decodedByteLength=32*1024*1024;envelope.digest=createHash('sha256').update(expanded).digest('hex');`, 'decompression failed'),
  new RuntimeWireDeliveryFault('resource tampering despite a matching compressed envelope',
    `const delivery=parse(gunzipSync(Buffer.from(envelope.body,'base64'),{maxOutputLength:32*1024*1024}).toString('utf8'));const bytes=Buffer.from(delivery.resources[0][1],'base64');bytes[0]^=1;delivery.resources[0][1]=bytes.toString('base64');const encoded=Buffer.from(JSON.stringify(delivery));envelope.body=gzipSync(encoded).toString('base64');envelope.decodedByteLength=encoded.length;envelope.digest=createHash('sha256').update(encoded).digest('hex');`, 'resource bytes differ from their proof'),
]) {
  test(`public wrapper refuses ${fault.name} before target execution`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sennel-command-wire-'));
    let runtime;
    t.after(() => closeFixture(runtime, root));
    const entry = path.join(root, 'entry.mjs');
    fs.copyFileSync(sourceEntry, entry);
    const effect = path.join(root, 'target-effect');
    const witnessed = path.join(root, 'wire-fault-observed.json');
    const target = path.join(root, 'target.cjs');
    fs.writeFileSync(target, `require('node:fs').writeFileSync(${JSON.stringify(effect)},'forbidden');`);
    const preload = `import fs from 'node:fs';import {gzipSync,gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
      const parse=JSON.parse;let mutated=false;
      JSON.parse=function(input,...args){
        const response=parse.call(this,input,...args);
        if(!mutated&&response?.operation==='runtime-snapshot'&&response.payload?.ok===true){
          const envelope=response.payload.value;
          if(envelope?.schemaVersion!==1||envelope.encoding!=='gzip-base64')throw new Error('Fixture did not receive the production wire representation');
          ${fault.mutation}
          fs.writeFileSync(${JSON.stringify(witnessed)},JSON.stringify({fault:${JSON.stringify(fault.name)},observed:true}),{flag:'wx'});
          mutated=true;
        }
        return response;
      };`;
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, environment: {} });
    const invocation = new NodeScriptInvocation({ script: entry,
      args: ['command', '--', process.execPath, target], cwd: root,
      env: { ...process.env, NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}` } });
    const result = await runtime.enter(() => executeManagedProcess(invocation, [], { runtime, timeoutMs: 30000 }));
    assert.deepEqual(JSON.parse(fs.readFileSync(witnessed, 'utf8')), { fault: fault.name, observed: true });
    assert.equal(result.code, 125);
    assert.match(result.stderr, /COMMAND_BOOTSTRAP_FAILED/);
    assert.ok(result.stderr.includes(fault.explanation), 'the authenticated delivery must fail at its declared proof boundary');
    assert.equal(fs.existsSync(effect), false);
    const execution = runtime.inspect().executions.find((record) => record.executionId === runtime.executionId);
    assert.equal(execution.calls.length, 1, 'a rejected bootstrap must not reserve the target');
    assert.equal(execution.calls[0].parentCallId, null);
    const receipt = new ProcessExecutionStopReceipt(execution.calls[0].receipt);
    assert.equal(receipt.observation.kind, 'exited');
    assert.equal(receipt.observation.code, 125);
    assert.equal(receipt.observation.signal, null);
    await runtime.close();
    const fresh = ProcessExecutionRuntime.inspect({ mainRoot: root });
    assert.equal(fresh.slot, null);
    assert.deepEqual(fresh.executions.find((record) => record.executionId === runtime.executionId).calls[0].receipt, receipt.toJSON());
  });
}
