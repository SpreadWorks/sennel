import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { readManagedRecord } from "../../../src/lib/managed-process-protocol.js";
import { LinuxProcessStat } from "../../../src/lib/process-identity.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { awaitRuntimeBarrier } from "./process-runtime-flow-scenario.js";

/** A captured, ordinary descendant execs setsid only after the test's barrier. */
export class ManagedMigrationScenario {
  constructor(t, name, { race = false } = {}) {
    this.root = createTmpDir("managed-migration-");
    this.name = name;
    this.race = race;
    this.launcherExit = Promise.resolve();
    this.finished = false;
    this.abort = new AbortController();
    this.file = (name) => path.join(this.root, name);
    t.after(() => this.cleanup());
    const wrapper = this.file("launcher.mjs");
    const moduleUrl = (name) => JSON.stringify(new URL(`../../../src/lib/${name}.js`, import.meta.url).href);
    fs.writeFileSync(wrapper, `
      import fs from 'node:fs';
      import {ManagedLauncher} from ${moduleUrl("managed-process-launcher")};
      import {ProcessIdentitySource} from ${moduleUrl("process-identity")};
      let input=''; for await(const bytes of process.stdin) input+=bytes;
      const launcher=new ManagedLauncher(JSON.parse(input));
      const root=${JSON.stringify(this.root)};
      const kill=process.kill.bind(process);
      process.kill=(pid,signal)=>{if(signal!==0)fs.appendFileSync(root+'/signals.jsonl',JSON.stringify({pid,signal})+'\\n');return kill(pid,signal)};
      let raced=false;
      for(const method of ['assess','observe']) {
        const original=ProcessIdentitySource.prototype[method]; if(!original)continue;
        ProcessIdentitySource.prototype[method]=function(member){
          if(!raced&&fs.existsSync(root+'/arm-race')&&fs.existsSync(root+'/ready.json')
            &&member.pid===JSON.parse(fs.readFileSync(root+'/ready.json')).descendantPid){
            raced=true; fs.writeFileSync(root+'/observation-barrier','ready');
            const end=Date.now()+15000;
            while(!fs.existsSync(root+'/moved.json')&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
            if(!fs.existsSync(root+'/moved.json'))throw new Error('migration barrier deadline');
          }
          return original.call(this,member);
        };
      }
      // Only teardown enables this escape hatch for the broken baseline or
      // intentional refusal. Assertions require a natural finished outcome.
      const teardown=setInterval(()=>{
        if(fs.existsSync(root+'/cleanup')&&launcher.childClosed&&fs.existsSync(root+'/member-ended'))process.exit(0);
      },20); teardown.unref();
      await launcher.run();
    `);
    const originalSpawn = childProcess.spawn;
    this.mock = t.mock.method(childProcess, "spawn", (command, args, options) => {
      if (args[0]?.endsWith("/managed-process-launcher.js")) {
        const child = originalSpawn(command, [wrapper, ...args.slice(1)], options);
        this.launcher = child;
        this.launcherExit = once(child, "close");
        return child;
      }
      return originalSpawn(command, args, options);
    });
    syncBuiltinESMExports();
    const member = this.file("member.cjs");
    fs.writeFileSync(member, `
      const fs=require('node:fs'); const root=${JSON.stringify(this.root)};
      fs.writeFileSync(root+'/moved.tmp',JSON.stringify({pid:process.pid,stat:fs.readFileSync('/proc/'+process.pid+'/stat','utf8')}));
      fs.renameSync(root+'/moved.tmp',root+'/moved.json');
      let ended=false;
      const finish=()=>{if(ended)return;ended=true;fs.writeFileSync(root+'/member-ended','natural');process.exit(0)};
      fs.watch(root,()=>{if(fs.existsSync(root+'/release-member'))finish()});
      setTimeout(finish,20000);
      if(fs.existsSync(root+'/release-member'))finish();
    `);
    this.provider = this.file("provider.cjs");
    fs.writeFileSync(this.provider, `
      const fs=require('node:fs'),{spawn}=require('node:child_process'); const root=${JSON.stringify(this.root)};
      const child=spawn('/bin/bash',['-c','read -r -t 20 ignored; exec /usr/bin/setsid "$@"','migration',process.execPath,${JSON.stringify(member)}],{stdio:['pipe','ignore','ignore']});
      child.stdin.on('error',()=>{});
      fs.writeFileSync(root+'/ready.tmp',JSON.stringify({pid:process.pid,descendantPid:child.pid,stat:fs.readFileSync('/proc/'+child.pid+'/stat','utf8')}));
      fs.renameSync(root+'/ready.tmp',root+'/ready.json');
      let moved=false;
      const check=()=>{if(!moved&&fs.existsSync(root+'/move')){moved=true;child.stdin.end('move\\n')}
        if(fs.existsSync(root+'/release-provider')){process.stdout.write('provider completed');process.exit(0)}};
      fs.watch(root,check); check(); setTimeout(()=>process.exit(0),25000);
    `);
  }
  async start({ timeoutMs = 15000, graceMs = 100 } = {}) {
    this.runtime = await ProcessExecutionRuntime.acquire({ mainRoot: this.root, runId: "migration", specId: "migration" });
    this.invocation = this.runtime.enter(() => executeManagedProcess(process.execPath, [this.provider],
      { cwd: this.root, timeoutMs, graceMs, maxBuffer: 1024, abortSignal: this.abort.signal }))
      .then((result) => ({ result }), (error) => ({ error }))
      .then((outcome) => { this.finished = true; this.outcome = outcome; return outcome; });
    await awaitRuntimeBarrier(this.file("ready.json"), 10000);
    this.ready = JSON.parse(fs.readFileSync(this.file("ready.json")));
    this.birth = LinuxProcessStat.parse(this.ready.stat);
    await this.waitRecord((record) => record.members.some((member) => member.pid === this.ready.descendantPid));
    this.captured = this.readRecord();
    assert.equal(this.captured.members.find((member) => member.pid === this.ready.descendantPid).startFingerprint,
      String(this.birth.startFingerprint), "migration must follow durable birth capture");
    if (this.race) {
      fs.writeFileSync(this.file("arm-race"), "arm");
      await awaitRuntimeBarrier(this.file("observation-barrier"), 10000);
    }
    fs.writeFileSync(this.file("move"), "move");
    await awaitRuntimeBarrier(this.file("moved.json"), 10000);
    const movedText = JSON.parse(fs.readFileSync(this.file("moved.json"))).stat;
    this.moved = LinuxProcessStat.parse(movedText);
    assert.equal(this.moved.pid, this.birth.pid);
    assert.equal(this.moved.startFingerprint, this.birth.startFingerprint);
    assert.notEqual(this.moved.pgrp, this.birth.pgrp);
    // Read the OS fixture's SID independently of the product parser so the
    // identical harness also exercises the pre-fix product revision.
    const session = (text) => Number(text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/)[3]);
    assert.notEqual(session(movedText), session(this.ready.stat));
    assert.equal(LinuxProcessStat.parse(fs.readFileSync(`/proc/${this.ready.pid}/stat`, "utf8")).pgrp, this.captured.pgid);
  }
  readRecord() {
    const call = this.runtime.inspect().executions.at(-1).calls[0];
    return readManagedRecord(path.join(this.runtime.store.callDirectory(call.callId), "outcome.json"));
  }
  async waitRecord(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = this.readRecord();
      if (record && predicate(record)) return record;
      await delay(10);
    }
    throw new Error(`managed record barrier timed out: ${JSON.stringify(this.readRecord())}`);
  }
  releaseProvider() { fs.writeFileSync(this.file("release-provider"), "release"); }
  releaseMember() { fs.writeFileSync(this.file("release-member"), "release"); }
  signals() {
    const file = this.file("signals.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  evidence(outcome) {
    const directory = process.env.SENNEL_MIGRATION_EVIDENCE_DIR;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    const inventory = this.runtime.inspect();
    // Evidence outside private runtime records must contain no authority token.
    const sanitize = (value) => JSON.parse(JSON.stringify(value, (key, entry) =>
      ["ownerToken", "capability", "permit", "endpoint"].includes(key) ? undefined : entry));
    fs.writeFileSync(path.join(directory, `${this.name}.json`), JSON.stringify(sanitize({
      phase: "assertions-before-teardown", ready: this.ready, moved: this.moved,
      captured: this.captured, final: this.readRecord(), inventory,
      signals: this.signals(),
      result: outcome?.result ?? null, error: outcome?.error?.toJSON?.() ?? (outcome?.error ? { name: outcome.error.name, code: outcome.error.code } : null),
    }), null, 2));
  }
  async cleanup() {
    try {
      if (this.runtime && this.captured) this.evidence(this.outcome);
      fs.writeFileSync(this.file("move"), "cleanup");
      this.releaseMember(); this.releaseProvider();
      fs.writeFileSync(this.file("cleanup"), "teardown-only");
      if (this.invocation) await this.invocation;
      this.launcher?.ref();
      await this.launcherExit;
      if (this.runtime && !this.runtime.closed) {
        try { await this.runtime.close(); }
        catch (error) { if (!error.code?.startsWith("PROCESS_EXECUTION_")) throw error; }
      }
    } finally {
      this.mock.mock.restore(); syncBuiltinESMExports(); removeTmpDir(this.root);
    }
  }
}
