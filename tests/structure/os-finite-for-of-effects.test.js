import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/finite-for-of.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'for(const file of ["ordinary"]){fs.readFileSync(file);}',
 'for(const file of ["ordinary","other"]){fs.readFileSync(file);}',
 'for(const [name,file] of Object.entries({a:"ordinary",b:"other"})){fs.readFileSync(file);}',
 'for(const {file} of [{file:"ordinary"}]){fs.readFileSync(file);}',
 'function read(values){for(const file of values){fs.readFileSync(file);}}read(["ordinary"]);',
 'for(const files of [["ordinary"]]){for(const file of files){fs.readFileSync(file);}}',
 'for(let file of ["ordinary"]){fs.readFileSync(file);}',
 'for(const files of [["ordinary"]]){for(const file of files){fs.readFileSync(file);}fs.readFileSync("ordinary");}',

 'const file="/proc/self/stat";for(const file of ["ordinary"]){fs.readFileSync(file);}',
])test(`finite native iteration binds actual elements: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'for(const file of ["/proc/self/stat"]){fs.readFileSync(file);}',
 'for(const file of ["ordinary","/proc/self/stat"]){fs.readFileSync(file);}',
 'for(const [name,file] of Object.entries({a:"ordinary",b:"/proc/self/stat"})){fs.readFileSync(file);}',
 'for(const {file} of [{file:"/proc/self/stat"}]){fs.readFileSync(file);}',
 'function read(values){for(const file of values){fs.readFileSync(file);}}read(["ordinary"]);read(["/proc/self/stat"]);',
 'for(const files of [["/proc/self/stat"]]){for(const file of files){fs.readFileSync(file);}}',
 'for(const read of [fs.readFileSync]){opaque(read);}',
 'for(const file of foreign()){fs.readFileSync(file);}',
 'Array.prototype[Symbol.iterator]=foreign;for(const file of ["ordinary"]){fs.readFileSync(file);}',
 'const values=["ordinary"];opaque(values);for(const file of values){fs.readFileSync(file);}',
 'const values=["ordinary"];for(const file of values){values.push("/proc/self/stat");fs.readFileSync(file);}',
 'for(const file of ["ordinary"]){if(flag) break;fs.readFileSync(file);}',
 'for(const file of ["ordinary"]){continue;fs.readFileSync(file);}',
 'for await(const file of ["ordinary"]){fs.readFileSync(file);}',
 'for(const [] of [foreign()]){}',
 'for(const file of ["ordinary"]){foreign(fs.readFileSync);}',
 'const saved={};for(const [key,file] of [["good","ordinary"],["bad","/proc/self/stat"]]){saved[key]=()=>fs.readFileSync(file);}saved.bad();',
 'class Reader {constructor(){for(const [key,file] of [["file","/proc/self/stat"]]){this[key]=file;}}read(){fs.readFileSync(this.file);}}new Reader().read();',
 'const holder={};for(const [key,file] of [["file","/proc/self/stat"]]){holder[key]=file;}fs.readFileSync(holder.file);',
 'for(const values of [foreign()]){for(const file of values){fs.readFileSync(file);}}',
 'for(const values of [["ordinary"]]){for(const file of values){if(flag)break;fs.readFileSync(file);}}',
 'for(const file of []){fs.readFileSync("/proc/self/stat");}',
 'for(const file of []){[fs].map(api=>api.readFileSync("/proc/self/stat"));}',
 'for(const file of ["ordinary"]){if(false){[fs].map(api=>api.readFileSync("/proc/self/stat"));}}',
 'for(const file of ["ordinary"]){function unused(){[fs].map(api=>api.readFileSync("/proc/self/stat"));}}',
 'for(const [file=[fs].map(api=>api.readFileSync("/proc/self/stat"))] of [["ordinary"]]){}',


])test(`iteration retains every source origin and unresolved control: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
