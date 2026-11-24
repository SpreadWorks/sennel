import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Gate a real coordinator's owned response-stage unlink in the caller's fixture root. */
export class ManagedResponsePublicationGate {
  constructor(root, { operation = null } = {}) {
    this.releasePath = path.join(root, 'release-owned-publication');
    this.blockedPath = path.join(root, 'owned-publication-blocked');
    this.preloadPath = path.join(root, 'pause-owned-response.mjs');
    fs.writeFileSync(this.preloadPath, `
      import fs from 'node:fs';import path from 'node:path';
      const unlink=fs.unlinkSync;let paused=false;const pause=new Int32Array(new SharedArrayBuffer(4));
      const operation=${JSON.stringify(operation)};
      fs.unlinkSync=function(file){
        if(!paused&&path.basename(path.dirname(String(file)))==='responses'&&path.basename(String(file)).startsWith('.')&&String(file).endsWith('.tmp')
          &&(operation===null||JSON.parse(fs.readFileSync(file,'utf8')).operation===operation)){
          paused=true;
          fs.writeFileSync(${JSON.stringify(this.blockedPath)},JSON.stringify({links:fs.lstatSync(file).nlink}));
          while(!fs.existsSync(${JSON.stringify(this.releasePath)}))Atomics.wait(pause,0,0,10);
        }
        return unlink.call(this,file);
      };
    `);
  }

  coordinatorEnvironment(environment = process.env) {
    return { ...environment,
      NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ''} --import=${pathToFileURL(this.preloadPath).href}`.trim() };
  }

  release() { fs.writeFileSync(this.releasePath, 'release'); }
  observedLinks() { return JSON.parse(fs.readFileSync(this.blockedPath, 'utf8')).links; }
}
