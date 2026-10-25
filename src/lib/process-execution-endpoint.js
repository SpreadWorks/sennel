import path from "node:path";
import crypto from "node:crypto";
import { ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { executionValueDigest, executionValueSnapshot } from "./process-execution-values.js";

/** Retained mailbox location, separate from the checkout's runtime inventory storage. */
export class ProcessExecutionControlEndpoint {
  #value;
  constructor(value) {
    if (value === null || typeof value !== "object" || Object.keys(value).length !== 4
      || !["host", "port", "mailbox", "storage"].every((key) => Object.hasOwn(value, key))) {
      throw new TypeError("Coordinator endpoint requires its current storage authority");
    }
    const storage = ReadOnlyProcessRuntimeStorage.validateGrant(value.storage);
    const session = path.dirname(value.mailbox?.requests ?? "");
    const namespace = path.dirname(session);
    if (value.host !== "127.0.0.1" || value.port !== null && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
      || value.mailbox === null || typeof value.mailbox !== "object" || Object.keys(value.mailbox).length !== 2
      || path.dirname(namespace) !== path.join(storage.directory, "control") || !/^[a-f0-9]{64}$/.test(path.basename(namespace))
      || !/^session-[0-9a-f-]{36}$/.test(path.basename(session))
      || value.mailbox.requests !== path.join(session, "requests") || value.mailbox.responses !== path.join(session, "responses")) {
      throw new TypeError("Coordinator endpoint is outside its separately owned control storage");
    }
    this.#value = executionValueSnapshot(value);
    Object.freeze(this);
  }
  static create(storage, executionRoot) {
    if (!(storage instanceof ReadOnlyProcessRuntimeStorage)) throw new TypeError("Endpoint creation requires minted control storage");
    const control = storage.authority.descendant(path.join(storage.directory, "control", executionValueDigest(executionRoot)), { create: true });
    const session = control.descendant(path.join(control.directory, `session-${crypto.randomUUID()}`), { create: true });
    const requests = session.descendant(path.join(session.directory, "requests"), { create: true });
    const responses = session.descendant(path.join(session.directory, "responses"), { create: true });
    return new this({ host: "127.0.0.1", port: null,
      mailbox: { requests: requests.directory, responses: responses.directory }, storage: storage.toJSON() });
  }
  assertCheckout(executionRoot) {
    const namespace = path.join(this.#value.storage.directory, "control", executionValueDigest(executionRoot));
    if (path.dirname(path.dirname(this.#value.mailbox.requests)) !== namespace) {
      throw new TypeError("Coordinator endpoint belongs to another checkout");
    }
    return this;
  }
  assertStorage() { return ReadOnlyProcessRuntimeStorage.fromGrant(this.#value.storage); }
  #mailboxAuthority(name) { return this.assertStorage().authority.descendant(this.#value.mailbox[name]); }
  requestAuthority() { return this.#mailboxAuthority("requests"); }
  responseAuthority() { return this.#mailboxAuthority("responses"); }
  withPort(port) { return new ProcessExecutionControlEndpoint({ ...this.#value, port }); }
  toJSON() { return executionValueSnapshot(this.#value); }
}
