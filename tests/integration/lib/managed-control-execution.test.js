import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RuntimeChildExecution } from "../../../src/lib/runtime-package.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const moduleURL = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);

// Intercept only socket delivery. Reservation, permits, launcher supervision,
// output spooling, termination proof and runtime persistence stay in production.
async function scenario(t, mode) {
  const root = createTmpDir("managed-control-execution-");
  t.after(() => removeTmpDir(root));
  const wrapper = path.join(root, "launcher.mjs");
  const coordinator = path.join(root, "coordinator.mjs");
  fs.writeFileSync(wrapper, `
    import fs from 'node:fs';
    import {ManagedLauncher} from ${moduleURL("managed-process-launcher")};
    let input='';for await(const bytes of process.stdin)input+=bytes;
    const config=JSON.parse(input),mode=${JSON.stringify(mode)};
    class DeliveryFaultLauncher extends ManagedLauncher {
      connect(socket) {
        const end=socket.end.bind(socket);
        socket.end=(text,...args)=>{
          const response=JSON.parse(text);
          // Legacy wire responses used 'response'; their payload still identifies state.
          const start=response.operation==='start'||response.operation==='response'&&response.payload.state==='running'&&!this.startReplySeen;
          if(start) {
            this.startReplySeen=true;
            this.startReplies=(this.startReplies||0)+1;
            fs.appendFileSync('start-replies',JSON.stringify({
              requestId:response.requestId??null,payloadDigest:response.payloadDigest??null,
              acceptance:response.payload.startRequest??null,
              observed:fs.existsSync('output-observed')})+'\\n');
            if(mode==='lost-start'&&this.startReplies===1){socket.destroy();return socket;}
            if(mode==='lost-start'&&this.startReplies===2)fs.writeFileSync('release','yes');
            if(mode==='delayed-start'&&this.startReplies===1){
              const deliver=()=>{
                if(!fs.existsSync('output-observed')||!fs.existsSync('stderr-observed'))return;
                watcher.close();
                fs.writeFileSync('delayed-start',JSON.stringify({observed:true,replyBytes:response.payload.outcome.output.stdout.byteLength,
                  stderrReplyBytes:response.payload.outcome.output.stderr.byteLength}));
                end(text,...args);
              };
              const watcher=fs.watch('.',deliver);
              socket.once('close',()=>watcher.close());
              deliver();return socket;
            }
          }
          if(mode==='delayed-start'&&response.operation==='status')fs.writeFileSync('release','yes');
          if(mode==='lost-status'&&response.operation==='status'){socket.destroy();return socket;}
          if(mode==='timeout-status'&&response.operation==='status'){socket.destroy();return socket;}
          if(mode==='lost-stop'&&response.operation==='stop'){socket.destroy();return socket;}
          return end(text,...args);
        };
        super.connect(socket);
      }
    }
    await new DeliveryFaultLauncher(config).run();
  `);
  fs.writeFileSync(coordinator, `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${moduleURL("process-execution-runtime")};
    import {executeManagedProcess} from ${moduleURL("managed-process")};
    import {Envelope} from ${moduleURL("flow-envelope")};
    const original=childProcess.spawn;
    childProcess.spawn=function(command,args,options){
      if(args[0]?.endsWith('/managed-process-launcher.js'))args=[${JSON.stringify(wrapper)},...args.slice(1)];
      return original.call(this,command,args,options);
    };syncBuiltinESMExports();
    const mode=${JSON.stringify(mode)},controller=new AbortController();
    const runtime=await ProcessExecutionRuntime.acquire({mainRoot:process.cwd()});
    let result=null,error=null,closureFailure=null,activityObservations=0;const stdoutCallbacks=[],stderrCallbacks=[];
    try{
      result=await runtime.enter(()=>executeManagedProcess(process.execPath,['-e',
        "const fs=require('fs');fs.appendFileSync('spawns','x');process.stdout.write('worker-output');"+
        "if("+JSON.stringify(mode)+"==='delayed-start')process.stderr.write('worker-error');"+
        "if("+JSON.stringify(mode)+"==='lost-stop')process.on('SIGTERM',()=>{});"+
        "setInterval(()=>{if(fs.existsSync('release'))process.exit(0)},10)"],{
        cwd:process.cwd(),timeoutMs:mode==='timeout-status'?10000:25000,graceMs:100,
        abortSignal:controller.signal,
        activityMonitor:mode==='delayed-start'?{start(){},stop(){},observeOutput(){activityObservations++;}}:undefined,
        onStdout(text){stdoutCallbacks.push(text);fs.writeFileSync('output-observed','yes');if(mode==='lost-stop')controller.abort(new Error('requested abort'));},
        onStderr(text){stderrCallbacks.push(text);fs.writeFileSync('stderr-observed','yes');}
      }));
    }catch(cause){
      error=cause instanceof ProcessExecutionControlFailure
        ?{name:cause.name,envelope:Envelope.fail('run','control',cause.code,cause.message,{processExecutionControlFailure:cause.toJSON()}).toJSON()}
        :{name:cause.name,message:cause.message,stopConfirmed:cause.stopEvidence?.confirmed??false,
          receipt:cause.processExecutionStopReceipt?.toJSON()??null};
    }finally{try{await runtime.close()}catch(cause){closureFailure={code:cause.code,message:cause.message};}}
    const state=ProcessExecutionRuntime.inspect({mainRoot:process.cwd()});
    process.stdout.write(JSON.stringify({result,error,closureFailure,state,
      spawns:fs.existsSync('spawns')?fs.readFileSync('spawns','utf8'):'',
      startReplies:fs.existsSync('start-replies')?fs.readFileSync('start-replies','utf8').trim().split('\\n').map(JSON.parse):[],
      observed:fs.existsSync('output-observed'),stdoutCallbacks,stderrCallbacks,activityObservations,
      delayedStart:fs.existsSync('delayed-start')?JSON.parse(fs.readFileSync('delayed-start','utf8')):null}));
  `);
  const execution = await RuntimeChildExecution.runAsync(coordinator, [], { cwd: root, timeout: 35000, maxBuffer: 1024 * 1024 });
  assert.equal(execution.ok, true, execution.stderr);
  const value = JSON.parse(execution.stdout);
  if (mode === "lost-status") {
    const reader = spawn(process.execPath, ["--input-type=module", "-e", `
      import {ProcessExecutionRuntime,ProcessExecutionControlFailure} from ${moduleURL("process-execution-runtime")};
      const state=ProcessExecutionRuntime.inspect({mainRoot:${JSON.stringify(root)}});
      const failure=ProcessExecutionControlFailure.fromStored(state.executions[0].calls[0].controlFailure);
      process.stdout.write(JSON.stringify({state,failure:failure.toJSON()}));
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    reader.stdout.on("data", (bytes) => { stdout += bytes; }); reader.stderr.on("data", (bytes) => { stderr += bytes; });
    const [code, signal] = await once(reader, "exit");
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    value.freshRead = JSON.parse(stdout);
  }
  return value;
}

test("lost accepted start response retries the same worker and observes output during the retry wait", async (t) => {
  const value = await scenario(t, "lost-start");
  assert.equal(value.error, null, JSON.stringify(value.error));
  assert.equal(value.closureFailure, null);
  assert.equal(value.result.stdout, "worker-output");
  assert.equal(value.spawns, "x", "response loss cannot reserve or spawn a replacement worker");
  assert.equal(value.startReplies.length, 2);
  assert.equal(value.startReplies[1].requestId, value.startReplies[0].requestId);
  assert.equal(value.startReplies[1].payloadDigest, value.startReplies[0].payloadDigest);
  assert.equal(value.startReplies[1].observed, true, "output remains observable before the resend");
  assert.equal(value.state.executions[0].calls.length, 1);
  assert.equal(value.state.executions[0].calls[0].receipt.stopEvidence.status, "confirmed");
});

test("exhausted status delivery preserves identical communication evidence in registry and CLI envelope", async (t) => {
  const value = await scenario(t, "lost-status");
  assert.equal(value.closureFailure, null);
  assert.equal(value.error.name, "ProcessExecutionControlFailure");
  const failure = value.error.envelope.data.processExecutionControlFailure;
  const root = value.state.executions[0], call = root.calls[0];
  assert.deepEqual(failure, call.controlFailure);
  assert.deepEqual(failure, value.freshRead.failure);
  assert.deepEqual(value.freshRead.state, value.state);
  assert.equal(failure.executionId, root.executionId);
  assert.equal(failure.callId, call.callId);
  assert.equal(failure.communication.operation, "status");
  assert.equal(failure.communication.cutoff, "budget-exhausted");
  assert.equal(failure.communication.attempts.length, 3);
  assert.deepEqual(failure.communication.attempts.map((attempt) => attempt.responseDeadlineMs), [2000, 6000, 14000]);
  assert.equal(failure.communication.stopConfirmation, "confirmed");
  assert.equal(value.observed, true);
  assert.equal(value.spawns, "x");
  assert.equal(root.status, "closed");
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
  assert.ok(call.stopOperation.deadline - call.stopOperation.startedAt <= 2200.001);
  const published = JSON.stringify(value.error.envelope);
  assert.equal(published.includes(call.capability), false);
  assert.equal(published.includes(root.coordinatorIdentity.ownerToken), false);
  assert.equal(/ownerToken|capability|environment|stack/.test(published), false);
});

test("execution deadline during disconnected status retains ordinary timeout after durable stop proof", async (t) => {
  const value = await scenario(t, "timeout-status");
  assert.equal(value.closureFailure, null);
  assert.equal(value.error.name, "AgentTimeoutError");
  assert.equal(value.error.stopConfirmed, true);
  assert.equal(value.spawns, "x");
  const call = value.state.executions[0].calls[0];
  assert.equal(call.controlFailure, null);
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
});

test("lost stop response converges on the receipt and keeps an abort as an ordinary abort", async (t) => {
  const value = await scenario(t, "lost-stop");
  assert.equal(value.closureFailure, null);
  assert.equal(value.error.message, "requested abort");
  assert.equal(value.error.stopConfirmed, true);
  assert.equal(value.spawns, "x");
  const call = value.state.executions[0].calls[0];
  assert.equal(call.controlFailure, null);
  assert.equal(call.receipt.stopEvidence.status, "confirmed");
  assert.equal(call.stopOperation.reason, "abort");
});

test("delayed older start response cannot redeliver output already observed while awaiting its reply", async (t) => {
  const value = await scenario(t, "delayed-start");
  assert.equal(value.error, null, JSON.stringify(value.error));
  assert.equal(value.closureFailure, null);
  assert.deepEqual(value.delayedStart, { observed: true, replyBytes: 0, stderrReplyBytes: 0 });
  assert.equal(value.result.stdout, "worker-output");
  assert.equal(value.result.stderr, "worker-error");
  assert.equal(value.spawns, "x");
  assert.equal(value.state.executions[0].calls.length, 1);
  assert.equal(value.state.executions[0].calls[0].receipt.stopEvidence.status, "confirmed");
  assert.deepEqual({ stdout: value.stdoutCallbacks, stderr: value.stderrCallbacks, activityObservations: value.activityObservations },
    { stdout: ["worker-output"], stderr: ["worker-error"], activityObservations: 2 },
    "a stale reply cannot rewind output cursors or repeat activity observations");
});
