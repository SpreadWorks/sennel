import { RuntimeRequestReference, RuntimeRequestCompletionSection, RuntimeRequestHistorySection } from "../../../src/lib/process-execution-request-block.js";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { ManagedProcessMessage } from "../../../src/lib/managed-process-protocol.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";
import { executionUuid } from "../../../src/lib/process-execution-values.js";
import { immutableCommandEnvironment } from "../../../src/lib/command-invocation.js";

/** Native filesystem faults delivered to the actual owned coordinator. */
export class RuntimeRegistryPublicationFailure {
  constructor(root, { boundary = "after-publication", callFact = "receipt", mutation = null, archivePath = null, pendingOperation = null, environment = process.env } = {}) {
    const inheritedEnvironment = immutableCommandEnvironment(environment);
    if (pendingOperation !== null && (!ManagedProcessMessage.reservesCall(pendingOperation) || boundary !== "after-readback")) throw new TypeError("Pending publication operation is invalid");
    if (!["before-publication", "after-publication", "after-readback"].includes(boundary)) throw new TypeError("Registry publication fault boundary is invalid");
    if (!["receipt", "controlFailure"].includes(callFact)) throw new TypeError("Registry publication fault call fact is invalid");
    const mutations = ["malformed-registry", "changed-registry", "replaced-registry", "changed-anchor", "changed-archive", "unexpected-call-directory", "replaced-owner"];
    if (boundary === "after-readback" ? !mutations.includes(mutation) : mutation !== null) throw new TypeError("Registry readback mutation is invalid");
    if (mutation === "changed-archive" && !path.isAbsolute(archivePath ?? "")) throw new TypeError("Archive mutation requires its actual absolute path");
    this.witness = path.join(root, "fault-observed.json");
    this.ownerLockPathFile = path.join(root, "fault-owner-path.json");
    const source = `import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
      const rename = fs.renameSync, open = fs.openSync, read = fs.readFileSync, close = fs.closeSync;
      let denied = null, callId = null, requestId = null, observed = false, readbackDescriptor = null, readbackCompleted = false;
      const observe = (phase, target) => {
        if (observed) return;
        fs.writeFileSync(${JSON.stringify(this.witness)}, JSON.stringify({
          boundary:${JSON.stringify(boundary)},callFact:${JSON.stringify(callFact)},callId,target,phase,errorCode:'EIO'}));
        observed = true;
      };
      const mutateAfterReadback = () => {
        observed = true;
        const before = fs.statSync(denied, {bigint:true}), bytes = read(denied);
        const mutation = ${JSON.stringify(mutation)};
        let mutationPath = denied, ownerGenerationChanged = null, ownerBytesPreserved = null, sameArchiveIdentity = null;
        if (mutation === 'malformed-registry') fs.writeFileSync(denied, '{');
        else if (mutation === 'changed-registry') {
          const record = JSON.parse(bytes);
          record.payload.executions.at(-1).runId = 'changed-after-publication';
          record.digest = crypto.createHash('sha256').update(JSON.stringify(record.payload)).digest('hex');
          fs.writeFileSync(denied, JSON.stringify(record));
        } else if (mutation === 'replaced-registry') {
          const replacement = denied + '.fixture-replacement';
          fs.writeFileSync(replacement, bytes, {flag:'wx',mode:Number(before.mode)&0o7777});
          rename.call(fs, replacement, denied);
        } else if (mutation === 'changed-anchor') {
          mutationPath = path.join(path.dirname(denied), 'authority.json');
          const anchor = JSON.parse(read(mutationPath));
          anchor.executionRoot = path.join(anchor.executionRoot, 'changed-after-publication');
          fs.writeFileSync(mutationPath, JSON.stringify(anchor));
        } else if (mutation === 'changed-archive') {
          mutationPath = ${JSON.stringify(archivePath)};
          const archiveBefore = fs.statSync(mutationPath, {bigint:true});
          const archive = JSON.parse(read(mutationPath));
          archive.payload.unexpectedReadbackField = true;
          archive.digest = crypto.createHash('sha256').update(JSON.stringify(archive.payload)).digest('hex');
          fs.writeFileSync(mutationPath, JSON.stringify(archive));
          const archiveAfter = fs.statSync(mutationPath, {bigint:true});
          sameArchiveIdentity = archiveBefore.dev === archiveAfter.dev && archiveBefore.ino === archiveAfter.ino;
        } else if (mutation === 'replaced-owner') {
          mutationPath = JSON.parse(read(${JSON.stringify(this.ownerLockPathFile)}));
          const original = read(mutationPath), ownerBefore = fs.statSync(mutationPath, {bigint:true});
          rename.call(fs, mutationPath, mutationPath + '.fixture-original');
          fs.writeFileSync(mutationPath, original, {flag:'wx',mode:0o600});
          const ownerAfter = fs.statSync(mutationPath, {bigint:true});
          ownerGenerationChanged = ownerBefore.dev !== ownerAfter.dev || ownerBefore.ino !== ownerAfter.ino;
          ownerBytesPreserved = original.equals(read(mutationPath));
        } else {
          mutationPath = path.join(path.dirname(denied), 'calls', crypto.randomUUID());
          fs.mkdirSync(mutationPath);
        }
        const after = fs.statSync(denied, {bigint:true});
        fs.writeFileSync(${JSON.stringify(this.witness)}, JSON.stringify({
          boundary:${JSON.stringify(boundary)},mutation,callFact:${JSON.stringify(callFact)},callId,requestId,target:denied,mutationPath,
          ...(mutation === 'changed-archive' ? {sameArchiveIdentity} : {}),
          phase:'after-readback-before-store-read',publicationReadbackCompleted:readbackCompleted,
          sameRegistryIdentity:before.dev===after.dev && before.ino===after.ino,
          sameRegistryBytes:bytes.equals(read(denied)),
          ...(mutation === 'replaced-owner' ? {ownerGenerationChanged,ownerBytesPreserved} : {})}), {flag:'wx'});
      };
      fs.renameSync = function(source, target) {
        if (path.basename(String(target)) === 'registry.json') {
          const record = JSON.parse(read(source));
          // Revision9 may store a fact inline or by its accepted request.
          // This only selects the external fault's boundary; the scenario
          // still verifies the actual child effect and physical receipt.
          const selectedFact = ${JSON.stringify(callFact)};
          const reference = selectedFact === 'receipt' ? 'terminalRequest' : 'failureRequest';
          const current = record.payload.executions.at(-1), pendingOperation = ${JSON.stringify(pendingOperation)};
          let selected = null;
          if (pendingOperation !== null) {
            const head = current?.requestHistoryHead;
            if (current?.calls.length === 0 && Array.isArray(head)) {
              const blockPath = path.join(path.dirname(String(target)), 'requests', current.executionId, 'blocks', head[0] + '.json');
              // The production writer publishes these canonical dependencies
              // before its final registry rename. They select the pending request;
              // the mutation still waits for that root's rename and readback.
              const block = JSON.parse(read(blockPath)).payload;
              const section = block.sections.find(section => crypto.createHash('sha256').update(JSON.stringify(section)).digest('hex') === head[1]);
              if (section?.acceptance.operation === pendingOperation) selected = section.acceptance;
            }
          } else selected = current?.calls.find(call =>
            call[selectedFact] !== null && call[selectedFact] !== undefined || Object.hasOwn(call, reference)) ?? null;
          if (selected !== null) {
            if (pendingOperation === null) callId = selected.callId;
            else requestId = selected.requestId;
            if (${JSON.stringify(boundary)} === 'before-publication') {
              observe('publication', String(target));
              throw Object.assign(new Error('Fixture registry publication unavailable'),{code:'EIO'});
            }
            const result = rename.call(this, source, target); denied = String(target); return result;
          }
        }
        return rename.call(this, source, target);
      };
      if (${JSON.stringify(boundary)} === 'after-readback') fs.closeSync = function(descriptor) {
        const result = close.call(this, descriptor);
        if (descriptor === readbackDescriptor) { readbackCompleted = true; readbackDescriptor = null; }
        return result;
      };
      fs.openSync = function(file, ...args) {
        if (${JSON.stringify(boundary)} === 'after-readback') {
          if (readbackCompleted && !observed && String(file) === path.join(path.dirname(denied), 'authority.json')) mutateAfterReadback();
          const descriptor = open.call(this,file,...args);
          if (String(file) === denied && !readbackCompleted) readbackDescriptor = descriptor;
          return descriptor;
        }
        if (String(file) === denied) {
          observe('readback', String(file));
          throw Object.assign(new Error('Fixture registry readback unavailable'),{code:'EIO'});
        }
        return open.call(this,file,...args);
      };`;
    this.environment = nativeFaultEnvironment(source, inheritedEnvironment);
    Object.freeze(this);
  }
}

function nativeFaultEnvironment(source, environment) {
  const inherited = immutableCommandEnvironment(environment);
  const key = Object.keys(inherited).find((name) => name.toUpperCase() === "NODE_OPTIONS") ?? "NODE_OPTIONS";
  return immutableCommandEnvironment({ ...inherited,
    [key]: `${inherited[key] ?? ""} --import=data:text/javascript;base64,${Buffer.from(source).toString("base64")}`.trim() });
}

/** Native acceptance/effect faults for one actual request in the owned coordinator. */
export class RuntimeRequestEffectFailure {
  constructor(root, { requestId, mode, environment = process.env }) {
    executionUuid(requestId, "request effect ID");
    if (!["pending-readback", "completion-publication", "spool-publication",
      "before-effect-registry-change", "after-effect-registry-change", "observation-readback",
      "observation-publication", "after-observation-registry-change"].includes(mode)) throw new TypeError("Request effect fault mode is invalid");
    this.witness = path.join(root, "request-effect-fault.json");
    const source = `import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
      const link=fs.linkSync,rename=fs.renameSync,open=fs.openSync,close=fs.closeSync,unlink=fs.unlinkSync,read=fs.readFileSync;
      const mode=${JSON.stringify(mode)},requestId=${JSON.stringify(requestId)},root=${JSON.stringify(path.resolve(root))};
      let ledger=null,registry=null,armed=false,observed=false,readback=null,readbackComplete=false,observationRegistry=null,observationFreshReads=0;
      const isLedger=target=>path.basename(String(target))===requestId+'.json'&&String(target).startsWith(root+path.sep)
        &&path.basename(path.dirname(path.dirname(String(target))))==='requests';
      const witness=(phase,target)=>{observed=true;fs.writeFileSync(${JSON.stringify(this.witness)},JSON.stringify({requestId,mode,phase,target,...(mode==='after-observation-registry-change'?{freshRegistryReadOrdinal:observationFreshReads}:{})}),{flag:'wx'});};
      const unavailable=(phase,target)=>{witness(phase,target);throw Object.assign(new Error('Fixture request effect publication unavailable'),{code:'EIO'});};
      const mutateRegistry=phase=>{
        const record=JSON.parse(read(registry));record.payload.executions.at(-1).runId='fixture-request-boundary-change';
        record.digest=crypto.createHash('sha256').update(JSON.stringify(record.payload)).digest('hex');
        fs.writeFileSync(registry,JSON.stringify(record));witness(phase,registry);
      };
      fs.linkSync=function(source,target){
        const result=link.call(this,source,target);
        if(isLedger(target)){ledger=String(target);registry=path.join(path.dirname(path.dirname(path.dirname(ledger))),'registry.json');armed=true;}
        return result;
      };
      fs.openSync=function(file,...args){
        if(!observed&&String(file)===observationRegistry)unavailable('observation-effect-and-response-visible-before-readback',String(file));
        if(armed&&!observed&&String(file)===ledger&&mode==='pending-readback')unavailable('pending-visible-before-readback',String(file));
        if(armed&&!observed&&readbackComplete&&mode==='before-effect-registry-change'
          &&String(file)===path.join(path.dirname(registry),'authority.json'))mutateRegistry('after-pending-before-effect');
        // For the leaf observation, these are exactly the pre-effect and post-dispatch
        // fresh reads after durable pending readback. No timer or fabricated event.
        if(armed&&!observed&&readbackComplete&&mode==='after-observation-registry-change'
          &&String(file)===path.join(path.dirname(registry),'authority.json')){
          observationFreshReads++;
          if(observationFreshReads===2)mutateRegistry('after-observation-before-completion');
        }
        const descriptor=open.call(this,file,...args);
        if(armed&&String(file)===ledger&&!readbackComplete)readback=descriptor;
        return descriptor;
      };
      fs.closeSync=function(descriptor){const result=close.call(this,descriptor);
        if(descriptor===readback){readback=null;readbackComplete=true;}return result;};
      fs.renameSync=function(source,target){
        if(armed&&!observed&&['observation-readback','observation-publication'].includes(mode)&&path.basename(String(target))==='registry.json'){
          const record=JSON.parse(read(source));
          // Select only this accepted request in its exact execution namespace.
          // Current roots link observations to already-published request blocks.
          // This chooses an external fault point, never validates or authorizes
          // a runtime; the scenario reads its selected section with the codec.
          const executionId=path.basename(path.dirname(ledger));
          const observedRequest=record.payload.executions.filter(execution=>execution.executionId===executionId).some(execution=>
            execution.calls.some(call=>{
              const reference=call.exitObservation;
              if(reference===undefined)return false;
              const block=JSON.parse(read(path.join(path.dirname(String(target)),'requests',executionId,'blocks',reference[0]+'.json'))).payload;
              return block.sections.some(section=>section.acceptance.requestId===requestId&&section.acceptance.operation==='observe'
                &&section.observation!==null&&section.observation.callId===call.callId);
            }));
          if(observedRequest){
            if(mode==='observation-publication')unavailable('observation-effect-and-response-before-publication',String(target));
            const result=rename.call(this,source,target);observationRegistry=String(target);return result;
          }
        }
        if(armed&&!observed&&mode==='completion-publication'&&isLedger(target))unavailable('after-effect-before-completion',String(target));
        if(armed&&!observed&&mode==='spool-publication'&&path.basename(String(target))==='stdout.bin')unavailable('later-spool-publication',String(target));
        return rename.call(this,source,target);
      };
      fs.unlinkSync=function(file){const result=unlink.call(this,file);
        if(armed&&!observed&&mode==='after-effect-registry-change'&&path.basename(String(file))==='stdout.bin.capture.transition'){
          const capture=String(file).slice(0,-'.transition'.length);
          if(JSON.parse(read(capture)).prefix!==null)mutateRegistry('after-spool-effect-before-completion');
        }return result;};`;
    this.environment = nativeFaultEnvironment(source, environment);
    this.requestId = requestId;
    Object.freeze(this);
  }

  /** A retained pending UUID may return only its strict refusal or the exact
   * immutable first transport response; neither permits repeating the effect. */
  async assertPendingReplay({ request, readRecord, grant, operation, data, firstFailure }) {
    await assert.rejects(request(), error => {
      if (error.code === "PROCESS_EXECUTION_REQUEST_UNCONFIRMED") {
        assert.equal(readRecord().payload.response, null);
        return true;
      }
      assert.equal(error.code, firstFailure.code);
      const original = new ManagedProcessMessage(grant, operation, { grant, data }, { requestId: this.requestId });
      const mailbox = grant.endpoint.mailbox;
      const bytes = new AtomicFile(path.join(mailbox.responses, `${this.requestId}.json`)).read();
      assert.notEqual(bytes, null);
      const savedRequest = ManagedProcessMessage.from(JSON.parse(new AtomicFile(path.join(mailbox.requests, `${this.requestId}.json`)).read()));
      savedRequest.assertPayload(); assert.deepEqual(savedRequest, original);
      const response = ManagedProcessMessage.from(JSON.parse(bytes));
      assert.equal(response.respondsTo(original), true); assert.equal(response.payload.ok, false);
      const cached = ProcessExecutionControlFailure.fromStored(response.payload.error);
      assert.equal(cached.code, firstFailure.code); assert.equal(cached.reason, firstFailure.reason);
      assert.equal(readRecord().payload.response, null);
      return true;
    });
  }
}

/** Fail readback only after one armed event fact has been globally published. */
export class RuntimeEventPublicationFailure {
  constructor(root, { environment = process.env } = {}) {
    const inheritedEnvironment = immutableCommandEnvironment(environment);
    this.armFile = path.join(root, "event-publication-fault-arm.json");
    this.witness = path.join(root, "event-publication-fault.json");
    const source = `import fs from 'node:fs';import path from 'node:path';
      const rename=fs.renameSync,open=fs.openSync,read=fs.readFileSync;
      const armFile=${JSON.stringify(this.armFile)},witness=${JSON.stringify(this.witness)};
      let committedRegistry=null,armed=null,observed=false;
      const readArm=()=>{try{return JSON.parse(read(armFile));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
      const includesFact=(envelope,arm)=>{
        const execution=envelope?.payload?.executions?.find(entry=>entry.events?.some(event=>event.eventId===arm.eventId));
        if(!execution)return false;
        const facts=arm.operation==='ack-events'?execution.eventAcknowledgements:execution.runtimeOnlyDispositions;
        return facts.some(fact=>fact.eventId===arm.eventId);
      };
      fs.renameSync=function(from,to){
        if(!observed&&path.basename(String(to))==='registry.json'){
          const candidate=readArm();
          if(candidate&&['ack-events','dispose-runtime-events'].includes(candidate.operation)){
            const envelope=JSON.parse(read(from));
            if(includesFact(envelope,candidate)){
              const result=rename.call(this,from,to);committedRegistry=String(to);armed=candidate;return result;
            }
          }
        }
        return rename.call(this,from,to);
      };
      fs.openSync=function(file,...args){
        if(committedRegistry!==null&&!observed&&String(file)===committedRegistry){
          observed=true;
          fs.writeFileSync(witness,JSON.stringify({requestId:armed.requestId,eventId:armed.eventId,operation:armed.operation,
            phase:'global-fact-published-before-transaction-readback',errorCode:'EIO'}),{flag:'wx'});
          throw Object.assign(new Error('Fixture event publication readback unavailable'),{code:'EIO'});
        }
        return open.call(this,file,...args);
      };`;
    this.environment = nativeFaultEnvironment(source, inheritedEnvironment);
    Object.freeze(this);
  }
}

/** Read the exact linked physical fact for diagnostics, without expanding or
 * accepting an interrupted registry. Normal inspect/settlement still refuse.
 */
export function readPhysicalRuntimeCompletion(store, executionId, value) {
  return readPhysicalRuntimeSection(store, executionId, value, RuntimeRequestCompletionSection);
}

export function readPhysicalRuntimeHistory(store, executionId, value) {
  return readPhysicalRuntimeSection(store, executionId, value, RuntimeRequestHistorySection);
}

function readPhysicalRuntimeSection(store, executionId, value, Section) {
  const reference = RuntimeRequestReference.fromStored(value);
  assert.notEqual(reference, null);
  const section = store.requestStorage.readBlock(executionId, reference.blockId).section(reference.digest);
  assert.ok(section instanceof Section);
  assert.equal(section.executionId, executionId);
  assert.equal(section.digest, reference.digest);
  return section;
}
