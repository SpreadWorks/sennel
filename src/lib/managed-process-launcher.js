// Internal process-group anchor. Only this live process can signal its own group.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedOutputSpool } from "./managed-process-output.js";
import net from "node:net";
import { spawn } from "node:child_process";
import { ProcessIdentitySource } from "./process-identity.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { ManagedStopOperation } from "./managed-stop-operation.js";
import { ManagedStopOperationStore } from "./managed-stop-store.js";
import { MANAGED_REQUEST_INACTIVITY_MS } from "./managed-control-policy.js";
import {
  ManagedProcessMessage, ManagedRequestAcceptance, ManagedProcessSnapshot, writeManagedRecord, managedControlFailure, managedMemberFailure,
} from "./managed-process-protocol.js";

export class ManagedLauncher {
  constructor(config) {
    this.config = config;
    this.call = config.call;
    this.identity = new ProcessIdentitySource().createOwner(this.call.ownerToken);
    this.members = new Map([[process.pid, this.identity]]);
    this.state = "waiting";
    this.stdout = new ManagedOutputSpool(this.call, "stdout", config.maxBuffer);
    this.stderr = new ManagedOutputSpool(this.call, "stderr", config.maxBuffer);
    this.outcome = { providerStarted: false, code: null, signal: null, timedOut: false, aborted: false, finalAction: null, stdinError: null };
    this.child = null;
    this.controlFailure = null;
    this.exiting = false;
    this.startRequest = null;
    this.stopRequest = null;
    this.stopOperation = null;
    this.stopStore = new ManagedStopOperationStore(this.call);
  }
  record() {
    return { ...this.call, launcherIdentity: this.identity, pgid: process.pid,
      providerIdentity: this.providerIdentity ?? null,
      members: [...this.members.values()], state: this.state,
      outcome: { ...this.outcome, output: { maximum: this.config.maxBuffer,
        stdout: this.stdout.persist({ deadline: this.stopOperation?.deadline }), stderr: this.stderr.persist({ deadline: this.stopOperation?.deadline }) } },
      controlFailure: this.controlFailure, startRequest: this.startRequest, stopRequest: this.stopRequest,
      stopOperation: this.stopOperation?.toJSON() ?? null };
  }
  save() { writeManagedRecord(this.call.outcomePath, this.record(), { deadline: this.stopOperation?.deadline }); }
  capture() {
    return new ManagedProcessSnapshot({ ...this.call, pgid: process.pid,
      launcherIdentity: this.identity, members: [...this.members.values()] }, {
      providerIdentity: this.providerIdentity, operation: "launcher-capture",
      persistMembers: (members) => {
        this.members = new Map(members.map((member) => [member.pid, member]));
        this.save();
      },
    });
  }
  async run() {
    process.on("SIGTERM", () => this.stop("external-term"));
    process.on("SIGINT", () => this.stop("external-interrupt"));
    this.server = net.createServer((socket) => this.connect(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.call.endpoint, resolve); });
    writeManagedRecord(this.call.helloPath, this.record());
    this.save();
    this.deadline = setTimeout(() => this.stop("timeout"), Math.max(1, this.config.deadline - Date.now()));
    this.poll = setInterval(() => {
      try {
        const snapshot = this.capture();
        if (this.stdout.dirty || this.stderr.dirty) this.save();
        if (this.state !== "waiting" && this.childDone && this.childClosed && snapshot.isStopped({ excludeLauncher: true })) this.finish();
      } catch (error) { this.fail(error); }
    }, 20);
  }
  connect(socket) {
    let input = "";
    socket.on("error", () => { /* A departed coordinator cannot end supervision. */ });
    socket.setTimeout(MANAGED_REQUEST_INACTIVITY_MS, () => socket.destroy());
    socket.on("data", (bytes) => {
      input += bytes;
      if (input.length > 1024 * 1024) return socket.destroy();
      const end = input.indexOf("\n");
      if (end === -1) return;
      socket.removeAllListeners("data");
      let request;
      try { request = ManagedProcessMessage.from(JSON.parse(input.slice(0, end))); }
      catch { socket.destroy(); return; }
      if (!request.matches(this.call)) return socket.destroy();
      socket.setTimeout(0);
      try {
        request.assertPayload();
        if (request.operation === "start") this.start(request.payload, request);
        else if (request.operation === "stop") {
          if (this.stopRequest !== null && !this.stopRequest.matches(request)) {
            throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Launcher already accepted another stop request");
          }
          const operation = ManagedStopOperation.fromPayload(request.payload);
          if (request.requestId !== operation.requestId) {
            throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Stop request differs from its durable operation");
          }
          this.stop(request.payload.reason, operation, request);
        }
        else if (request.operation !== "status") throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Unknown launcher operation");
        const response = this.record();
        socket.end(`${JSON.stringify(request.respond(response))}\n`);
      } catch (error) {
        if (error instanceof TypeError) error = managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Managed request payload is invalid", error);
        const refused = error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_REQUEST_MISMATCH";
        if (!refused) this.fail(error);
        const failure = refused ? error.withContext(this.call).toJSON() : this.controlFailure;
        socket.end(`${JSON.stringify(request.respond({ error: failure }))}\n`);
      }
    });
  }
  start({ permit, environment }, request) {
    if (this.startRequest !== null) {
      if (!this.startRequest.matches(request)) throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Launcher already accepted another start request");
      return;
    }
    if (this.state !== "waiting") throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Launcher no longer accepts a start permit");
    if (!new ManagedProcessMessage(permit, "start").matches(this.call) || permit.ownerEpoch !== this.call.ownerEpoch
      || permit.bindingDigest !== this.call.bindingDigest) throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Start permit does not match physical call");
    if (Date.now() >= this.config.deadline) { this.stop("timeout"); return; }
    this.state = "running";
    this.startRequest = new ManagedRequestAcceptance(request);
    this.save();
    try {
      this.child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd, env: { ...this.config.env, ...environment },
        detached: false,
        stdio: [this.config.input == null ? "ignore" : "pipe", "pipe", "pipe", ...this.config.extraDescriptors],
      });
      this.outcome.providerStarted = this.child.pid != null;
      this.child.on("error", (error) => {
        this.outcome.error = { code: error.code, message: error.message };
        this.childDone = true;
        try { this.save(); } catch (error) { this.fail(error); }
      });
      this.child.on("close", () => { this.childClosed = true; });
      this.child.on("exit", (code, signal) => {
        this.outcome.code = code;
        this.outcome.signal = signal;
        this.childDone = true;
        try { this.save(); } catch (error) { this.fail(error); }
      });
      this.child.stdout.on("data", (bytes) => this.collect("stdout", bytes));
      this.child.stderr.on("data", (bytes) => this.collect("stderr", bytes));
      if (this.child.pid != null) {
        let identity;
        try { identity = new ProcessIdentitySource({ pid: this.child.pid }).createOwner(this.call.ownerToken); }
        catch (cause) {
          throw managedControlFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "Direct provider birth identity is unavailable", cause);
        }
        // The owned child can leave the group before its first enumeration.
        // Preserve its birth independently so group absence cannot hide it.
        this.members.set(identity.pid, identity);
        this.providerIdentity = identity;
        this.save();
      }
      if (this.config.input != null) {
        this.child.stdin.on("error", (error) => { this.outcome.stdinError = { code: error.code, message: error.message }; });
        this.child.stdin.end(Buffer.from(this.config.input, "base64"));
      }
      this.capture();
    } catch (error) { this.fail(error); }
  }
  collect(stream, bytes) {
    if (!this[stream].append(bytes)) {
      this.controlFailure = managedControlFailure("PROCESS_EXECUTION_OUTPUT_LIMIT", `${stream} exceeds the managed output bound`)
        .withContext(this.call).toJSON();
      this.stop("output-limit");
    }
  }
  stop(reason, operation = null, request = null) {
    if (this.controlBlocked || (request === null && (this.state === "stopping" || this.exiting))) return;
    try {
      const chosen = this.stopStore.claim(operation ?? { reason, graceMs: this.config.graceMs });
      if (operation !== null && !chosen.matches(operation)) {
        throw managedControlFailure("PROCESS_EXECUTION_REQUEST_MISMATCH", "Stop request differs from the accepted operation");
      }
      this.stopOperation = chosen;
      if (request !== null) this.stopRequest ??= new ManagedRequestAcceptance(request);
      if (this.state === "stopping" || this.exiting) { this.save(); return; }
    } catch (error) {
      if (request !== null) throw error;
      this.fail(error); return;
    }
    reason = this.stopOperation.reason;
    this.outcome.timedOut = reason === "timeout";
    this.outcome.aborted = reason === "abort";
    if (this.refuseExpiredSignal()) return;
    this.outcome.finalAction = "SIGTERM";
    this.state = "stopping";
    try { this.capture(); this.save(); }
    catch (error) { this.fail(error); return; }
    if (!this.child) { this.childDone = true; this.childClosed = true; this.finish(); return; }
    if (this.refuseExpiredSignal(null)) return;
    // The TERM handler above keeps the anchor alive until provider reaping and
    // member observation finish, or the grace timer kills the entire group.
    process.kill(-process.pid, "SIGTERM");
    this.grace = setTimeout(() => {
      if (this.refuseExpiredSignal()) return;
      this.outcome.finalAction = "SIGKILL";
      try { this.capture(); this.save(); }
      catch (error) { this.fail(error); return; }
      if (this.refuseExpiredSignal("SIGTERM")) return;
      process.kill(-process.pid, "SIGKILL");
    }, Math.min(this.stopOperation.graceMs, this.stopOperation.remainingMs()));
  }
  refuseExpiredSignal(previousAction = this.outcome.finalAction) {
    if (this.stopOperation.remainingMs() > 0) return false;
    this.outcome.finalAction = previousAction;
    this.stopAtDeadline();
    return true;
  }
  stopAtDeadline() {
    try {
      const snapshot = this.capture();
      if (!snapshot.isStopped({ excludeLauncher: true })) {
        this.fail(snapshot.stopFailure("Managed stop deadline expired before signaling could finish"));
        return;
      }
      this.state = "stopping";
      if (!this.child) { this.childDone = true; this.childClosed = true; }
      this.save();
      if (this.childDone && this.childClosed) this.finish();
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    let failure = error instanceof ProcessExecutionControlFailure ? error
      : managedControlFailure("PROCESS_EXECUTION_LAUNCHER_FAILURE", error.message, error);
    if (failure.diagnostic === null) failure = managedMemberFailure({ ...this.call, pgid: process.pid }, this.identity, {
      code: failure.code, message: failure.message, operation: "launcher-control", role: "launcher", cause: failure });
    this.controlFailure = failure.withContext(this.call).toJSON();
    this.controlBlocked = true;
    this.state = "control-failed";
    clearInterval(this.poll);
    clearTimeout(this.deadline);
    clearTimeout(this.grace);
    // Unknown membership or uncertain persistence withdraws signal authority.
    // Keep the authenticated endpoint and pipe drains alive for diagnosis.
    try { this.save(); } catch { /* The endpoint still reports the control failure. */ }
  }
  finish() {
    if (this.controlBlocked || this.exiting) return;
    this.exiting = true;
    clearInterval(this.poll);
    clearTimeout(this.deadline);
    clearTimeout(this.grace);
    // Give pipe events already queued by the child's exit one event-loop turn.
    setImmediate(() => {
      this.state = "finished";
      try { this.save(); }
      catch (error) { process.exitCode = 1; }
      this.server.close(() => process.exit(process.exitCode || 0));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const bytes of process.stdin) input += bytes;
  const launcher = new ManagedLauncher(JSON.parse(input));
  await launcher.run();
}
