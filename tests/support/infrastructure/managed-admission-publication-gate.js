import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Observe actual coordinator TCP frames and hold its second real query write. */
export class ManagedAdmissionPublicationGate {
  #watcher = null;
  constructor(root, firstRequestId, secondRequestId) {
    this.root = root;
    this.firstRequestId = firstRequestId;
    this.secondRequestId = secondRequestId;
    this.releasePath = path.join(root, "release-second-admission");
    this.blockedPath = path.join(root, "second-admission-blocked");
    this.preloadPath = path.join(root, "observe-admission-publication.mjs");
    fs.writeFileSync(this.preloadPath, `
      import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
      import {syncBuiltinESMExports} from 'node:module';
      const ids=new Set(${JSON.stringify([firstRequestId, secondRequestId])});
      const createServer=net.createServer;
      net.createServer=function(...args){
        const index=args.findIndex(value=>typeof value==='function');const listener=args[index];
        args[index]=function(socket){
          let input='';let observed=false;
          socket.prependListener('data',bytes=>{
            if(observed)return;input+=bytes.toString('utf8');const newline=input.indexOf('\\n');
            if(newline<0)return;observed=true;const message=JSON.parse(input.slice(0,newline));
            if(ids.has(message.requestId))fs.writeFileSync(path.join(${JSON.stringify(root)},'frame-'+message.requestId),'received');
          });
          return listener(socket);
        };
        return createServer.apply(this,args);
      };
      const unlink=fs.unlinkSync;let blocked=false;const pause=new Int32Array(new SharedArrayBuffer(4));
      fs.unlinkSync=function(file){
        const name=String(file);
        if(!blocked&&path.basename(name).startsWith(${JSON.stringify(`.${secondRequestId}.json.`)})&&name.endsWith('.tmp')
          &&name.includes(path.sep+'requests'+path.sep)){
          const record=JSON.parse(fs.readFileSync(file,'utf8'));
          if(record.payload?.requestId===${JSON.stringify(secondRequestId)}&&record.payload.response===null){
            blocked=true;fs.writeFileSync(${JSON.stringify(this.blockedPath)},JSON.stringify({requestId:record.payload.requestId,links:fs.lstatSync(file).nlink}));
            const heldUntil=performance.now()+30000;
            while(!fs.existsSync(${JSON.stringify(this.releasePath)})){
              if(performance.now()>=heldUntil)throw new Error('Owned admission publication fixture gate exceeded its finite hold');
              Atomics.wait(pause,0,0,Math.min(10,Math.max(1,heldUntil-performance.now())));
            }
          }
        }
        return unlink.call(this,file);
      };
      syncBuiltinESMExports();
    `);
  }

  coordinatorEnvironment(environment = process.env) {
    return { ...environment,
      NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --import=${pathToFileURL(this.preloadPath).href}`.trim() };
  }

  waitForFrames(requestIds = [this.firstRequestId, this.secondRequestId]) {
    return new Promise((resolve, reject) => {
      const ready = () => requestIds.every((id) => fs.existsSync(path.join(this.root, `frame-${id}`)));
      const watcher = this.#watcher = fs.watch(this.root, () => { if (ready()) { watcher.close(); resolve(); } });
      watcher.once("error", (cause) => { watcher.close(); reject(cause); });
      if (ready()) { watcher.close(); resolve(); }
    });
  }

  get released() { return fs.existsSync(this.releasePath); }
  get blocked() { return fs.existsSync(this.blockedPath); }
  release() { fs.writeFileSync(this.releasePath, "release"); }
  close() { this.release(); this.#watcher?.close(); }
  observation() { return JSON.parse(fs.readFileSync(this.blockedPath, "utf8")); }
}
