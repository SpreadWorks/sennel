import { isDeepStrictEqual } from "node:util";
import { executionValueDigest, executionValueSnapshot, freezeExecutionValue, ProcessExecutionValueEncoding, ProcessExecutionCommandDescriptor } from "./process-execution-values.js";

const capturedMetadataAuthority = Symbol("captured invocation metadata");
const capturedInvocations = new WeakMap();
const ownedPublicMetadata = new WeakSet();

function scalar(value, name) {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean"
    && !(typeof value === "number" && Number.isFinite(value))) throw new TypeError(`Public invocation ${name} must be scalar metadata`);
  return value;
}
function fields(target, source, names) {
  for (const name of names) if (Object.hasOwn(source, name)) target[name] = scalar(source[name], name);
}
function exact(value, restored, name) {
  if (!isDeepStrictEqual(value, restored.toJSON())) throw new TypeError(`${name} has unknown or private fields`);
  return restored;
}
class InvocationObservationBinding {
  constructor(value) {
    fields(this, value, ["flowVersionId", "runId", "specId", "nodeId", "taskId", "attemptId", "attemptSequence",
      "executionContractId", "executionGeneration", "outboxAttemptId"]);
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}
class InvocationPromptScope {
  constructor(value) { fields(this, value, ["stage", "round"]); Object.freeze(this); }
  toJSON() { return { ...this }; }
}
class InvocationPromptIdentity {
  constructor(value) {
    fields(this, value, ["batchDigest", "responseCallIndex", "transportOrdinal", "attempt", "maxAttempts", "requestDigest",
      "schemaDigest", "providerKey", "profileKey", "logicalInvocationId", "providerAttemptId"]);
    if (Object.hasOwn(value, "scope")) this.scope = value.scope === null ? null : new InvocationPromptScope(value.scope);
    Object.freeze(this);
  }
  toJSON() { return { ...this, ...(Object.hasOwn(this, "scope") ? { scope: this.scope?.toJSON() ?? null } : {}) }; }
}
class InvocationProviderAttempt {
  constructor(value) {
    fields(this, value, ["attemptId", "logicalInvocationId", "commandId", "provider", "providerKey", "profileKey", "attemptIndex",
      "index", "attempt", "maxAttempts", "inputCharacters", "measurementId"]);
    if (Object.hasOwn(value, "observationBinding")) this.observationBinding = value.observationBinding === null ? null : new InvocationObservationBinding(value.observationBinding);
    Object.freeze(this);
  }
  toJSON() { return { ...this, ...(Object.hasOwn(this, "observationBinding") ? { observationBinding: this.observationBinding?.toJSON() ?? null } : {}) }; }
}
class InvocationExecutionIdentity {
  constructor({ executableDigest, nodeImportDigests }) {
    if (typeof executableDigest !== "string" || !/^[a-f0-9]{64}$/.test(executableDigest) || !Array.isArray(nodeImportDigests)
      || nodeImportDigests.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw new TypeError("Invocation execution identity is invalid");
    this.executableDigest = executableDigest;
    this.nodeImportDigests = Object.freeze([...nodeImportDigests]);
    Object.freeze(this);
  }
  static capture(launch) {
    if (typeof launch?.executable !== "string") throw new TypeError("Private launch lacks its resolved executable");
    const key = Object.keys(launch.env ?? {}).find((name) => name.toUpperCase() === "NODE_OPTIONS");
    const options = key === undefined ? "" : launch.env[key];
    return new InvocationExecutionIdentity({ executableDigest: executionValueDigest(launch.executable),
      nodeImportDigests: options.split(/\s+/).filter((token) => token.startsWith("--import=")).map((token) => executionValueDigest(token)) });
  }
  matchesRuntimeDelivery(executable, flag) { return this.executableDigest === executionValueDigest(executable) && this.nodeImportDigests.includes(executionValueDigest(flag)); }
  toJSON() { return { executableDigest: this.executableDigest, nodeImportDigests: this.nodeImportDigests }; }
  static fromStored(value) { return exact(value, new InvocationExecutionIdentity(value), "Invocation execution identity"); }
}

/** Only semantic identifiers and the existing disclosure-safe command descriptor. */
class InvocationPublicMetadata {
  constructor(value, { privateInput = false } = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Public invocation metadata must be an object");
    fields(this, value, ["kind", "commandId", "providerAttemptId", "logicalInvocationId", "measurementId", "reservedAt"]);
    if (Object.hasOwn(value, "observationBinding")) this.observationBinding = value.observationBinding === null ? null : new InvocationObservationBinding(value.observationBinding);
    if (Object.hasOwn(value, "providerAttemptContext")) this.providerAttemptContext = value.providerAttemptContext === null ? null : new InvocationProviderAttempt(value.providerAttemptContext);
    if (Object.hasOwn(value, "promptProcessIdentity")) this.promptProcessIdentity = value.promptProcessIdentity === null ? null : new InvocationPromptIdentity(value.promptProcessIdentity);
    if (Object.hasOwn(value, "command")) this.command = value.command === null ? null : ProcessExecutionCommandDescriptor.fromStored(value.command);
    if (privateInput && value.launch !== undefined) this.executionIdentity = InvocationExecutionIdentity.capture(value.launch);
    else if (!privateInput && Object.hasOwn(value, "executionIdentity")) this.executionIdentity = InvocationExecutionIdentity.fromStored(value.executionIdentity);
    Object.freeze(this);
    if (new.target === InvocationPublicMetadata) ownedPublicMetadata.add(this);
  }
  toJSON() { return Object.fromEntries(Object.entries(this).map(([name, value]) => [name, value?.toJSON?.() ?? value])); }
  static fromStored(value) { return exact(value, new InvocationPublicMetadata(value), "Public invocation metadata"); }
}

/** One owned private snapshot and its lazily derived public disclosure. */
export class ProcessExecutionCapturedInvocation {
  #value;
  #encoding;
  #disclosure;
  constructor(value) {
    this.#value = freezeExecutionValue(executionValueSnapshot(value));
    this.#encoding = new ProcessExecutionValueEncoding(this.#value);
    if (this.#value !== null && typeof this.#value === "object") capturedInvocations.set(this.#value, this);
    Object.freeze(this);
  }
  static capture(value) {
    const captured = value !== null && typeof value === "object" ? capturedInvocations.get(value) : undefined;
    return captured ?? new ProcessExecutionCapturedInvocation(value);
  }
  get value() { return this.#value; }
  get digest() { return this.#encoding.digest; }
  text() { return this.#encoding.text(); }
  matches(value) {
    if (value === this.#value) return true;
    const captured = value !== null && typeof value === "object" ? capturedInvocations.get(value) : undefined;
    return this.#encoding.matches(captured?.#encoding ?? new ProcessExecutionValueEncoding(value));
  }
  get disclosure() {
    if (this.#disclosure === undefined) {
      this.#disclosure = new ProcessExecutionInvocationDisclosure({ invocation: this.#value === null ? null : new InvocationPublicMetadata(this.#value, { privateInput: true }),
        invocationDigest: this.#encoding.digest }, capturedMetadataAuthority);
    }
    return this.#disclosure;
  }
}

/** Public semantic projection bound to the exact full private invocation bytes. */
export class ProcessExecutionInvocationDisclosure {
  constructor({ invocation, invocationDigest }, authority = null) {
    if (typeof invocationDigest !== "string" || !/^[a-f0-9]{64}$/.test(invocationDigest)) throw new TypeError("Invocation digest is invalid");
    this.invocation = invocation === null ? null : authority === capturedMetadataAuthority || ownedPublicMetadata.has(invocation)
      ? invocation : InvocationPublicMetadata.fromStored(executionValueSnapshot(invocation));
    this.invocationDigest = invocationDigest;
    Object.freeze(this);
  }
  static capture(privateInvocation) {
    const captured = privateInvocation !== null && typeof privateInvocation === "object" ? capturedInvocations.get(privateInvocation) : undefined;
    if (captured !== undefined) return captured.disclosure;
    const full = executionValueSnapshot(privateInvocation);
    return new ProcessExecutionInvocationDisclosure({ invocation: full === null ? null : new InvocationPublicMetadata(full, { privateInput: true }), invocationDigest: executionValueDigest(full) }, capturedMetadataAuthority);
  }
  static fromStored(value) { return exact(value, new ProcessExecutionInvocationDisclosure(value), "Invocation disclosure"); }
  matchesPrivate(value) { return isDeepStrictEqual(this.toJSON(), ProcessExecutionInvocationDisclosure.capture(value).toJSON()); }
  toJSON() { return { invocation: this.invocation?.toJSON() ?? null, invocationDigest: this.invocationDigest }; }
}
