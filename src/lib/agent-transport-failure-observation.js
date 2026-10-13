import { AgentFailure, AgentTimeoutFailure, AgentProviderCompletionEvidence,
  AgentProcessStopEvidence, AgentProviderStartupFailureEvidence } from "./agent-failure.js";

/** Confirmed physical failure evidence, independent from provider retry policy. */
export class AgentTransportFailureObservation {
  constructor({ failure, providerKey, profileKey, attempt, maxAttempts }) {
    if (!(failure instanceof AgentFailure) || typeof providerKey !== "string" || !providerKey
      || typeof profileKey !== "string" || !profileKey || !Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < attempt
      || failure.attemptCount !== attempt || failure.maxAttempts !== maxAttempts) throw new TypeError("Transport failure observation identity is invalid");
    const completion = failure.providerCompletionEvidence;
    const startup = failure.providerStartupEvidence;
    const stop = failure instanceof AgentTimeoutFailure && failure.stopEvidence.confirmed ? failure.stopEvidence : null;
    if (completion === null && startup === null && stop === null) throw new TypeError("Transport failure has no confirmed physical observation");
    for (const evidence of [completion, startup].filter(Boolean)) {
      if (evidence.provider !== providerKey || evidence.profile !== profileKey
        || evidence.attemptCount !== attempt || evidence.maxAttempts !== maxAttempts) throw new TypeError("Transport failure proof belongs to a different provider attempt");
    }
    Object.assign(this, { failureCode: failure.code, retryable: failure.retryable, providerKey, profileKey, attempt, maxAttempts,
      providerCompletionEvidence: completion, stopEvidence: stop, providerStartupEvidence: startup });
    Object.freeze(this);
  }
  static fromFailure(failure, context) {
    if (!(failure instanceof AgentFailure)) throw new TypeError("Transport observation requires a typed Agent failure");
    if (failure.providerCompletionEvidence === null && failure.providerStartupEvidence === null
      && !(failure instanceof AgentTimeoutFailure && failure.stopEvidence.confirmed)) return null;
    return new this({ failure, ...context });
  }
  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Serialized transport observation is invalid");
    const completion = value.providerCompletionEvidence === null ? null : AgentProviderCompletionEvidence.fromJSON(value.providerCompletionEvidence);
    const startup = value.providerStartupEvidence === null ? null : AgentProviderStartupFailureEvidence.fromJSON(value.providerStartupEvidence);
    const stop = value.stopEvidence === null ? null : AgentProcessStopEvidence.from(value.stopEvidence);
    const failure = AgentFailure.from({ code: value.failureCode, message: "Observed provider transport failure", attemptCount: value.attempt,
      maxAttempts: value.maxAttempts, providerCompletionEvidence: completion, providerStartupEvidence: startup, stopEvidence: stop });
    const observation = new this({ failure, providerKey: value.providerKey, profileKey: value.profileKey, attempt: value.attempt, maxAttempts: value.maxAttempts });
    if (JSON.stringify(observation.toJSON()) !== JSON.stringify(value)) throw new TypeError("Serialized transport observation differs from its physical proof");
    return observation;
  }
  assertFailure(entry) {
    if (entry.code !== this.failureCode || entry.retryable !== this.retryable
      || ["providerKey", "profileKey", "attempt", "maxAttempts"].some((field) => entry[field] !== this[field])) {
      throw new TypeError("Saved transport failure differs from its observation");
    }
  }
  toJSON() { return { failureCode: this.failureCode, providerKey: this.providerKey, profileKey: this.profileKey,
    attempt: this.attempt, maxAttempts: this.maxAttempts, retryable: this.retryable,
    providerCompletionEvidence: this.providerCompletionEvidence?.toJSON() ?? null,
    stopEvidence: this.stopEvidence?.toJSON() ?? null, providerStartupEvidence: this.providerStartupEvidence?.toJSON() ?? null }; }
}
