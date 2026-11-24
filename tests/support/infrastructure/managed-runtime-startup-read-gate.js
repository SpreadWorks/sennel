import fs from "node:fs";
import path from "node:path";

/** Hold an actual owned child's first payload read before any delivery acknowledgement. */
export class ManagedRuntimeStartupReadGate {
  #child = null;
  #kill = null;
  constructor(root) {
    this.readyPath = path.join(root, "payload-read-started");
    this.stopPath = path.join(root, "startup-stop-requested");
    this.preloadPath = path.join(root, "hold-runtime-payload-read.cjs");
    fs.writeFileSync(this.preloadPath, `
      const fs=require('node:fs'),path=require('node:path');
      const {syncBuiltinESMExports}=require('node:module');
      const open=fs.openSync,read=fs.readFileSync,pause=new Int32Array(new SharedArrayBuffer(4));
      process.on('SIGTERM',()=>{});
      const hold=file=>{
        if(typeof file!=='string'||path.basename(file)!=='delivery.json.gz')return;
        fs.writeFileSync(${JSON.stringify(this.readyPath)},file);
        while(true)Atomics.wait(pause,0,0,1000);
      };
      fs.openSync=function(file,...args){hold(file);return open.call(this,file,...args)};
      fs.readFileSync=function(file,...args){hold(file);return read.call(this,file,...args)};
      syncBuiltinESMExports();
    `, { flag: "wx" });
  }
  coordinatorEnvironment(environment = process.env) {
    // CJS --require runs before ESM --import on every supported Node version.
    return { ...environment,
      NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --require=${JSON.stringify(this.preloadPath)}`.trim() };
  }
  observe(child) {
    this.#child = child; this.#kill = child.kill;
    const kill = this.#kill, gate = this;
    child.kill = function (...args) {
      const accepted = Reflect.apply(kill, this, args);
      const signal = args[0] ?? "SIGTERM";
      if (signal === "SIGTERM") fs.writeFileSync(gate.stopPath, JSON.stringify({ signal, accepted }));
      return accepted;
    };
  }
  readAttempt() { return fs.readFileSync(this.readyPath, "utf8"); }
  stopRequest() { return JSON.parse(fs.readFileSync(this.stopPath, "utf8")); }
  close() { if (this.#child !== null) this.#child.kill = this.#kill; }
}
