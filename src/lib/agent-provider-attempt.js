function requiredText(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty text`);
  return value;
}

/** Identity and provider-visible input at one transport dispatch boundary. */
export class AgentProviderAttemptContext {
  constructor({ attemptId, logicalInvocationId, commandId = null, provider, profileKey,
    attemptIndex, maxAttempts, inputCharacters, invocation = null } = {}) {
    this.attemptId = requiredText(attemptId, "Agent provider attempt identity");
    this.logicalInvocationId = requiredText(logicalInvocationId, "Agent logical invocation identity");
    this.commandId = commandId === null ? null : requiredText(commandId, "Agent command identity");
    this.provider = requiredText(provider, "Agent provider");
    this.providerKey = this.provider;
    this.profileKey = requiredText(profileKey, "Agent profile");
    if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0) throw new TypeError("Agent attempt index must be non-negative");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= attemptIndex) throw new TypeError("Agent maximum attempts must include the attempt");
    if (!Number.isSafeInteger(inputCharacters) || inputCharacters < 0) throw new TypeError("Agent attempt input characters must be non-negative");
    this.attemptIndex = attemptIndex;
    this.index = attemptIndex;
    this.attempt = attemptIndex + 1;
    this.maxAttempts = maxAttempts;
    this.inputCharacters = inputCharacters;
    this.invocation = invocation;
    if (new.target === AgentProviderAttemptContext) Object.freeze(this);
  }
}

/** A settled attempt; usage is normalized exclusively by Provider.parse(). */
export class AgentProviderAttemptRecord extends AgentProviderAttemptContext {
  constructor({ context, usage = null, status, providerStarted } = {}) {
    if (!(context instanceof AgentProviderAttemptContext)) throw new TypeError("Agent attempt record requires a typed context");
    super(context);
    if (!["completed", "empty", "failed"].includes(status)) throw new TypeError("Agent provider attempt status is invalid");
    if (typeof providerStarted !== "boolean") throw new TypeError("Agent provider-started observation must be boolean");
    this.usage = usage === null ? null : Object.freeze({ ...usage });
    this.status = status;
    this.providerStarted = providerStarted;
    Object.freeze(this);
  }
}

/** Observation never owns provider success, failure, or retry decisions. */
export class AgentProviderAttemptObserver {
  observe(_record) {
    throw new Error("AgentProviderAttemptObserver.observe() must be implemented");
  }

  observationFailed(_error, _record) {}
}

/** Optional asynchronous authorization before dispatch, independent of usage. */
export class AgentProviderAttemptAdmission {
  async beforeProviderAttempt(_context) {
    throw new Error("AgentProviderAttemptAdmission.beforeProviderAttempt() must be implemented");
  }
}

export async function observeAgentProviderAttempt(observer, record) {
  if (observer === null) return;
  try {
    await observer.observe(record);
  } catch (error) {
    try {
      await observer.observationFailed(error, record);
    } catch {
      // A diagnostic observer cannot change the provider's settlement either.
    }
  }
}
