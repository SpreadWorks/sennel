// Independently scheduled Sennel-owned control child. Package imports are pinned
// by RuntimeChildExecution before this entrypoint is evaluated.
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { ProcessExecutionCoordinator } from "./process-execution-runtime.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";
import { ManagedProcessMessage } from "./managed-process-protocol.js";
import { AtomicFile } from "./atomic-file.js";
import { ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { ProcessExecutionControlEndpoint } from "./process-execution-endpoint.js";
import { captureRegularFile, RegularFileReadReceipt } from "./regular-file-snapshot.js";

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
let coordinator;
let mailboxTimer;
let server;
let requests;
let responses;
let mailboxWatcher = null;
const sockets = new Set();
class PublishedMailboxResponse {
  constructor(request, response) {
    const message = ManagedProcessMessage.from(JSON.parse(request.text()));
    if (!ManagedProcessMessage.from(JSON.parse(response.text())).respondsTo(message)) throw new Error("Saved mailbox response belongs to a different request");
    this.request = new RegularFileReadReceipt(request);
    this.response = new RegularFileReadReceipt(response);
    this.payloadDigest = message.payloadDigest;
    Object.freeze(this);
  }
}
const answeredMailboxRequests = new Map();
const pendingMailboxRequests = new Map();
function publishResponse(response) {
  const message = ManagedProcessMessage.from(response);
  const file = new AtomicFile(path.join(responses.directory, `${message.requestId}.json`), { directoryAuthority: responses, maxBytes: MAX_MESSAGE_BYTES });
  const bytes = Buffer.from(JSON.stringify(response));
  const prior = file.readSnapshot();
  if (prior !== null) {
    if (!prior.bytes.equals(bytes)) throw new ProcessExecutionControlFailure("request-mismatch", "An immutable mailbox response cannot be replaced");
    return prior;
  }
  return file.write(bytes, { exclusive: true }).snapshot;
}
function failure(cause) {
  return cause instanceof ProcessExecutionControlFailure ? cause
    : new ProcessExecutionControlFailure("control-failed", cause.message, { cause });
}
function shutdownIfReleased() {
  if (!coordinator?.released) return;
  clearInterval(mailboxTimer);
  mailboxWatcher?.close();
  server.close(() => {});
  for (const socket of sockets) socket.end();
  if (process.connected) process.disconnect();
}
async function dispatch(raw) {
  // ProcessRuntimeStore.exclusive serializes every authoritative transition.
  // Waiting for a parent's start acknowledgement must not hold that queue.
  const message = ManagedProcessMessage.from(raw);
  try { return await coordinator.handle(message); }
  catch (cause) { return message.respond({ ok: false, error: failure(cause).toJSON() }); }
}
function mailboxFailure(cause) {
  // Publication/authority failures retain the same admission-fencing boundary.
  const report = () => {
    if (process.connected) process.send({ type: "diagnostic", error: failure(cause).toJSON() }, () => {});
  };
  return coordinator.hostDisconnected().then(() => { report(); shutdownIfReleased(); }, report);
}
async function scanMailbox() {
  if (!coordinator || coordinator.released) return;
  for (const name of requests.entries()) {
    // AtomicFile publishes only final .json names; producer stages are not requests.
    if (!name.endsWith(".json")) continue;
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("Coordinator mailbox contains an invalid request name");
    // A published response is immutable. Remember its successful publication
    // instead of rereading potentially package-sized snapshots on every scan.
    if (answeredMailboxRequests.has(name)) continue;
    if (pendingMailboxRequests.has(name)) continue;
    const snapshot = captureRegularFile(path.join(requests.directory, name), { label: "coordinator request",
      maxBytes: MAX_MESSAGE_BYTES, requireSingleLink: true, directoryAuthority: requests });
    const message = JSON.parse(snapshot.text());
    if (`${message.requestId}.json` !== name) throw new Error("Coordinator mailbox request ID does not match its filename");
    const responseFile = new AtomicFile(path.join(responses.directory, name), { directoryAuthority: responses, maxBytes: MAX_MESSAGE_BYTES });
    const prior = responseFile.readSnapshot();
    if (prior !== null) { answeredMailboxRequests.set(name, new PublishedMailboxResponse(snapshot, prior)); continue; }
    // Continue scanning later arrivals, including the actual executor's start
    // observation, while an authentication awaits that committed observation.
    const pending = dispatch(message).then((response) => {
      const current = captureRegularFile(path.join(requests.directory, name), { label: "coordinator request",
        maxBytes: MAX_MESSAGE_BYTES, requireSingleLink: true, directoryAuthority: requests, expectedIdentity: snapshot.identity });
      if (!current.bytes.equals(snapshot.bytes)) throw new ProcessExecutionControlFailure("request-mismatch", "Pending mailbox request changed before its response");
      answeredMailboxRequests.set(name, new PublishedMailboxResponse(current, publishResponse(response)));
      shutdownIfReleased();
    }).catch(mailboxFailure).finally(() => pendingMailboxRequests.delete(name));
    pendingMailboxRequests.set(name, pending);
    await setImmediate();
  }
}
async function start(configuration) {
  // Only mailbox control traffic uses this independently minted shared scratch.
  // Registry, calls, archives and locks keep their original storage policy.
  const endpointStorage = ReadOnlyProcessRuntimeStorage.fromGrant(configuration.endpointStorage);
  const mailbox = ProcessExecutionControlEndpoint.create(endpointStorage, configuration.executionRoot);
  requests = mailbox.requestAuthority();
  responses = mailbox.responseAuthority();
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    let complete = false;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (complete) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      complete = true;
      let raw;
      try { raw = JSON.parse(input.subarray(0, newline).toString("utf8")); }
      catch { socket.destroy(); return; }
      dispatch(raw).then((response) => socket.end(`${JSON.stringify(response)}\n`, shutdownIfReleased), () => socket.destroy());
    });
  });
  const tcpAvailable = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(true));
  });
  const endpoint = mailbox.withPort(tcpAvailable ? server.address().port : null).toJSON();
  try { coordinator = new ProcessExecutionCoordinator({ ...configuration, endpoint, publishResponse }); }
  catch (cause) { server.close(() => {}); throw cause; }
  let mailboxDirty = true;
  let nextMailboxScanAt = 0;
  const watchFailed = () => { mailboxWatcher?.close(); mailboxWatcher = null; mailboxDirty = true; };
  // A watch is only a wakeup hint, never file identity or request authority.
  // Polling remains functional when events are unavailable or lost (including
  // Windows directory moves and filesystems without native watch support).
  requests.assertStable();
  try {
    mailboxWatcher = fs.watch(requests.directory, { persistent: false }, () => { mailboxDirty = true; });
    mailboxWatcher.on("error", watchFailed);
  } catch { watchFailed(); }
  requests.assertStable();
  let scanning = false;
  mailboxTimer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    const now = performance.now();
    const scan = mailboxDirty || now >= nextMailboxScanAt;
    if (scan) {
      mailboxDirty = false;
      nextMailboxScanAt = now + (mailboxWatcher === null ? 100 : 1000);
    }
    (scan ? scanMailbox() : Promise.resolve()).then(() => coordinator.tick()).catch(mailboxFailure).finally(() => { scanning = false; });
  }, 10);
  process.send?.({ type: "ready", grant: coordinator.grant,
    record: coordinator.recoveryRoot ? null : coordinator.store.readInventory().executions.find((entry) => entry.executionId === coordinator.executionId),
    checkout: coordinator.store.checkout.toJSON() });
}
process.once("message", (message) => {
  start(message.configuration).catch((cause) => {
    clearInterval(mailboxTimer);
    process.send?.({ type: "failed", error: failure(cause).toJSON() }, () => process.disconnect?.());
    process.exitCode = 1;
  });
});
process.once("disconnect", () => {
  if (!coordinator || coordinator.released) return;
  coordinator.hostDisconnected().then(shutdownIfReleased).catch(() => {});
});
