import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = (relative) => pathToFileURL(path.resolve(relative)).href;

/** External provider scripts for the public argv wrapper's registered tree. */
export class RegisteredCommandLineage {
  constructor({ root, started, release, exited, stop }) {
    this.effect = path.join(root, ".tmp", "lineage-effects.jsonl");
    this.replay = path.join(root, ".tmp", "lineage-replay.json");
    this.child = path.join(root, ".tmp", "lineage-child.mjs");
    this.leaf = path.join(root, ".tmp", "lineage-leaf.mjs");
    this.graceMs = 5000;
    fs.mkdirSync(path.dirname(this.child), { recursive: true });
    this.argv = ["", "two words", '"quoted"', "C:\\path\\last\\", "日本語", "$HOME&value", "%PATH%", "`literal`"];
    const cli = path.resolve("src/sennel.js");
    this.wrapperArgs = [cli, "command", "--", process.execPath, this.child, ...this.argv];
    const processModule = moduleUrl("src/lib/process.js");
    fs.writeFileSync(this.leaf, [
      'import fs from "node:fs";import path from "node:path";',
      `fs.appendFileSync(${JSON.stringify(this.effect)},JSON.stringify(process.argv.slice(2))+"\\n");`,
      `fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({ready:true}));`,
      `const release=${JSON.stringify(release)};`,
      'await new Promise(resolve=>{const watcher=fs.watch(path.dirname(release),()=>{if(fs.existsSync(release)){watcher.close();resolve();}});if(fs.existsSync(release)){watcher.close();resolve();}});',
      'process.stdout.write("registered leaf completed");',
    ].join("\n"));
    fs.writeFileSync(this.child, [
      `await import(${JSON.stringify(moduleUrl("src/sennel.js"))});`,
      `const {runCmdAsync}=await import(${JSON.stringify(processModule)});`,
      `const result=await runCmdAsync(process.execPath,[${JSON.stringify(this.leaf)},...process.argv.slice(2)],{cwd:process.cwd(),timeout:120000});`,
      'process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;',
    ].join("\n"));
    this.startSource = [
      'const lineageAbort=new AbortController();',
      `const {RegisteredCommandOutcome}=await import(${JSON.stringify(moduleUrl("tests/support/infrastructure/registered-command-outcome.js"))});`,
      `const {NativeExecutableInvocation}=await import(${JSON.stringify(moduleUrl("src/lib/command-invocation.js"))});`,
      `const member=RegisteredCommandOutcome.execute(new NativeExecutableInvocation({executable:process.execPath,args:${JSON.stringify(this.wrapperArgs)},cwd:root}),{timeoutMs:120000,graceMs:${this.graceMs},abortSignal:lineageAbort.signal});`,
      'member.catch(()=>{});',
      `const memberStarted=${JSON.stringify(started)};`,
      'await new Promise(resolve=>{const watcher=fs.watch(path.dirname(memberStarted),()=>{if(fs.existsSync(memberStarted)){watcher.close();resolve();}});if(fs.existsSync(memberStarted)){watcher.close();resolve();}});',
    ];
    this.finishSource = [
      ...(stop ? ['lineageAbort.abort();'] : []),
      'let memberResult;',
      'try{memberResult=await member;}catch(error){',
      'const causes=[];const pending=[error];const seen=new Set();while(pending.length&&causes.length<12){const cause=pending.shift();if(cause==null||seen.has(cause))continue;seen.add(cause);causes.push({code:cause.code??null,reason:cause.reason??null,message:cause.message??String(cause)});if(cause.cause)pending.push(cause.cause);if(cause instanceof AggregateError)pending.push(...cause.errors);}',
      `writeMarker(${JSON.stringify(exited)},{failure:causes[0],causes,receipt:error.processExecutionStopReceipt?.toJSON()??null});throw error;}`,
      `writeMarker(${JSON.stringify(exited)},memberResult.toJSON());`,
      ...(stop ? [
        'if(memberResult.errorCode!=="ABORT_ERR"||memberResult.processExecutionStopReceipt?.stopEvidence.status!=="confirmed")throw new Error("The planned command abort did not return its exact confirmed receipt");',
      ] : []),
      `const {replayLineageCompletion}=await import(${JSON.stringify(moduleUrl("tests/support/infrastructure/registered-command-lineage.js"))});`,
      `writeMarker(${JSON.stringify(this.replay)},await replayLineageCompletion(root,memberResult.processExecutionStopReceipt));`,
      // The provider handles its intentionally aborted utility and returns its
      // valid sealed artifact. It does not turn that planned stop into a new
      // provider failure and an unrelated fresh worker correction.
      ...(!stop ? ['if(memberResult.code!==0)throw new Error("Registered command exited with code "+memberResult.code);'] : []),
    ];
  }
}

/** Resend the original completed transport request; never launch a new call. */
export async function replayLineageCompletion(root, receipt) {
  const { ProcessExecutionRuntime } = await import("../../../src/lib/process-execution-runtime.js");
  const { ProcessExecutionBinding, executionValueDigest } = await import("../../../src/lib/process-execution-values.js");
  const { managedRequest } = await import("../../../src/lib/managed-process-protocol.js");
  const client = await ProcessExecutionRuntime.fromRemoteGrant(JSON.parse(process.env.SENNEL_PROCESS_EXECUTION_SCOPE));
  try {
    const grant = client.remoteGrant();
    const execution = ProcessExecutionRuntime.inspect({ mainRoot: root }).executions.find(entry => entry.executionId === receipt.executionId);
    const call = execution.calls.find(entry => entry.callId === receipt.callId);
    const data = { call: { callId: call.callId, capability: call.capability,
      bindingDigest: new ProcessExecutionBinding(call.binding).digest }, outcome: call.outcome,
    observation: call.observation, output: receipt.output.toJSON() };
    const digest = executionValueDigest({ grant, data });
    const accepted = execution.requests.find(entry => entry.operation === "finish" && entry.payloadDigest === digest);
    if (accepted === undefined) throw new Error("The registered completion must have its original durable request");
    const replay = () => managedRequest(grant, "finish", { grant, data }, { requestId: accepted.requestId }).then(value => client.decodeResponse(value));
    const first = await replay();
    const second = await replay();
    return { requestId: accepted.requestId, first, second };
  } finally { await client.close(); }
}
