/**
 * Bounded provider protocol shared by Review phases that need a complete
 * phase-domain contract before a response can be accepted. It deliberately
 * does not know a phase's JSON shape, domain items, or recovery route.
 */

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export class ReviewProtocolContract {
  constructor({ phase, parse } = {}) {
    this.phase = requiredText(phase, "review protocol phase");
    if (typeof parse !== "function") throw new Error("review protocol parse must be a function");
    this.parse = parse;
    Object.freeze(this);
  }

  accept(rawResponse) {
    return this.parse(rawResponse);
  }
}

/** Bounded phase-neutral retry policy. Adapters choose its attempt limit. */
export class ReviewProtocolRetryPolicy {
  constructor({ maxAttempts = 2, initialCacheMode = "default", retryCacheMode = "refresh" } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16) {
      throw new Error("review protocol maxAttempts must be a bounded positive integer");
    }
    if (!new Set(["default", "bypass", "refresh"]).has(initialCacheMode)
      || !new Set(["default", "bypass", "refresh"]).has(retryCacheMode)) {
      throw new Error("review protocol cache modes are invalid");
    }
    this.maxAttempts = maxAttempts;
    this.initialCacheMode = initialCacheMode;
    this.retryCacheMode = retryCacheMode;
    Object.freeze(this);
  }

  attempt(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > this.maxAttempts) {
      throw new Error("review protocol attempt is outside its bounded policy");
    }
    return new ReviewProtocolAttempt({
      number,
      cacheMode: number === 1 ? this.initialCacheMode : this.retryCacheMode,
    });
  }

  canRetryContract(attempt) {
    return attempt instanceof ReviewProtocolAttempt && attempt.number < this.maxAttempts;
  }
}

export class ReviewProtocolAttempt {
  constructor({ number, cacheMode } = {}) {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error("review protocol attempt number must be positive");
    }
    if (!new Set(["default", "bypass", "refresh"]).has(cacheMode)) {
      throw new Error("review protocol attempt cacheMode is invalid");
    }
    this.number = number;
    this.cacheMode = cacheMode;
    Object.freeze(this);
  }
}

/** A separately bounded transport retry budget inside one contract attempt. */
export class ReviewProtocolTransportRetryPolicy {
  constructor({ retryCount = 0, retryDelayMs = 1, backoffFactor = 2 } = {}) {
    if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > 16) {
      throw new Error("review protocol transport retryCount must be bounded");
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
      throw new Error("review protocol transport retryDelayMs must be positive");
    }
    if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new Error("review protocol transport backoffFactor must be at least one");
    }
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.backoffFactor = backoffFactor;
    Object.freeze(this);
  }

  canRetry(cause, transportAttempt) {
    return cause?.retryable === true
      && transportAttempt instanceof ReviewProtocolTransportAttempt
      && transportAttempt.transportNumber <= this.retryCount;
  }

  delayBeforeRetry(transportAttempt) {
    if (!(transportAttempt instanceof ReviewProtocolTransportAttempt)
      || transportAttempt.transportNumber < 1
      || transportAttempt.transportNumber > this.retryCount) {
      throw new Error("review protocol transport retry delay is outside its bounded policy");
    }
    return this.retryDelayMs * Math.pow(this.backoffFactor, transportAttempt.transportNumber - 1);
  }
}

/** One concrete provider invocation, scoped to a phase-contract attempt. */
export class ReviewProtocolTransportAttempt {
  constructor({ protocolAttempt, transportNumber } = {}) {
    if (!(protocolAttempt instanceof ReviewProtocolAttempt)) {
      throw new Error("review protocol transport attempt requires a protocol attempt");
    }
    if (!Number.isSafeInteger(transportNumber) || transportNumber < 1) {
      throw new Error("review protocol transport attempt number must be positive");
    }
    this.protocolAttempt = protocolAttempt;
    // A provider retry must not replay a cache entry which preceded a
    // transient transport failure. Preserve the contract attempt's initial
    // mode only for the first invocation, then force fresh validated output.
    this.number = protocolAttempt.number;
    this.cacheMode = transportNumber === 1 ? protocolAttempt.cacheMode : "refresh";
    this.transportNumber = transportNumber;
    Object.freeze(this);
  }
}

/** A completed provider invocation, classified before its deferred side work settles. */
export class ReviewProtocolAttemptOutcome {
  constructor({ kind, cause = null } = {}) {
    const normalizedKind = requiredText(kind, "review protocol attempt outcome kind");
    if (!new Set([
      "accepted",
      "transport_retrying",
      "transport_failed",
      "contract_retrying",
      "contract_rejected",
      "effect_observed",
      "observation_unavailable",
    ]).has(normalizedKind)) {
      throw new Error("review protocol attempt outcome kind is invalid");
    }
    this.kind = normalizedKind;
    this.cause = cause;
    Object.freeze(this);
  }
}

/**
 * Phase-neutral boundary for side effects which must occur only after source
 * observation has decided whether a provider invocation can be retried.
 */
export class ReviewProtocolAttemptSettlement {
  constructor({ settle } = {}) {
    if (typeof settle !== "function") throw new Error("review protocol attempt settlement requires settle()");
    this.settle = settle;
    Object.freeze(this);
  }

  async finalize(transportAttempt, outcome) {
    if (!(transportAttempt instanceof ReviewProtocolTransportAttempt)) {
      throw new Error("review protocol attempt settlement requires a transport attempt");
    }
    if (!(outcome instanceof ReviewProtocolAttemptOutcome)) {
      throw new Error("review protocol attempt settlement requires an outcome");
    }
    await this.settle(transportAttempt, outcome);
  }
}

/** Observer-owned evidence that an attempt's external surface changed. */
export class ReviewProtocolEffectEvidence {
  constructor({ observer, detail = null } = {}) {
    this.observer = requiredText(observer, "review protocol effect observer");
    this.detail = detail;
    Object.freeze(this);
  }
}

/** Typed terminal protocol failure; phase adapters own user-facing mapping. */
export class ReviewProtocolFailure extends Error {
  constructor({ kind, attempt, maxAttempts, cause = null, effectEvidence = null } = {}) {
    const normalizedKind = requiredText(kind, "review protocol failure kind");
    if (!new Set(["contract_rejected", "effect_observed", "observation_unavailable"]).has(normalizedKind)) {
      throw new Error("review protocol failure kind is invalid");
    }
    if (!(attempt instanceof ReviewProtocolAttempt)) {
      throw new Error("review protocol failure requires its typed Attempt");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < attempt.number) {
      throw new Error("review protocol failure requires a bounded maximum attempt count");
    }
    if (effectEvidence !== null && !(effectEvidence instanceof ReviewProtocolEffectEvidence)) {
      throw new Error("review protocol failure effect evidence is invalid");
    }
    super(`review protocol ${normalizedKind.replaceAll("_", " ")}`);
    this.name = "ReviewProtocolFailure";
    this.kind = normalizedKind;
    this.attempt = attempt;
    this.maxAttempts = maxAttempts;
    this.cause = cause;
    this.effectEvidence = effectEvidence;
    Object.freeze(this);
  }
}

/** Successful complete contract acceptance plus its attempt observations. */
export class ReviewProtocolResult {
  constructor({ attempt, rawResponse, value, before, after } = {}) {
    if (!(attempt instanceof ReviewProtocolAttempt)) throw new Error("review protocol result requires its typed Attempt");
    this.attempt = attempt;
    this.rawResponse = rawResponse;
    this.value = value;
    this.before = before;
    this.after = after;
    Object.freeze(this);
  }
}

/**
 * Calls a provider and validates its complete phase contract. A contract
 * rejection is retried only under the supplied bounded policy and only if an
 * observer proves the provider call had no observed effect.
 */
export class ReviewProtocolController {
  constructor({
    contract,
    retryPolicy = new ReviewProtocolRetryPolicy(),
    transportRetryPolicy = new ReviewProtocolTransportRetryPolicy(),
  } = {}) {
    if (!(contract instanceof ReviewProtocolContract)) {
      throw new Error("review protocol requires a ReviewProtocolContract");
    }
    if (!(retryPolicy instanceof ReviewProtocolRetryPolicy)) {
      throw new Error("review protocol requires a ReviewProtocolRetryPolicy");
    }
    if (!(transportRetryPolicy instanceof ReviewProtocolTransportRetryPolicy)) {
      throw new Error("review protocol requires a ReviewProtocolTransportRetryPolicy");
    }
    this.contract = contract;
    this.retryPolicy = retryPolicy;
    this.transportRetryPolicy = transportRetryPolicy;
    Object.freeze(this);
  }

  async execute({ callAgent, observer = null, onAttempt = null, settlement = null } = {}) {
    if (typeof callAgent !== "function") throw new Error("review protocol callAgent must be a function");
    if (observer !== null && (typeof observer.capture !== "function" || typeof observer.hasEffect !== "function")) {
      throw new Error("review protocol observer must capture and compare effects");
    }
    if (settlement !== null && !(settlement instanceof ReviewProtocolAttemptSettlement)) {
      throw new Error("review protocol settlement must be a ReviewProtocolAttemptSettlement");
    }
    for (let number = 1; number <= this.retryPolicy.maxAttempts; number += 1) {
      const attempt = this.retryPolicy.attempt(number);
      let retryContract = false;
      for (let transportNumber = 1; transportNumber <= this.transportRetryPolicy.retryCount + 1; transportNumber += 1) {
        const transportAttempt = new ReviewProtocolTransportAttempt({ protocolAttempt: attempt, transportNumber });
        onAttempt?.(transportAttempt);
        let outcome = null;
        try {
          const before = this.#capture(observer, attempt, transportAttempt);
          let rawResponse;
          try {
            rawResponse = await callAgent(transportAttempt);
          } catch (cause) {
            const after = this.#capture(observer, attempt, transportAttempt);
            const effectEvidence = this.#effectEvidence(observer, before, after, attempt);
            if (effectEvidence !== null) {
              outcome = new ReviewProtocolAttemptOutcome({ kind: "effect_observed", cause });
              throw new ReviewProtocolFailure({ kind: "effect_observed", attempt, maxAttempts: this.retryPolicy.maxAttempts, cause, effectEvidence });
            }
            if (this.transportRetryPolicy.canRetry(cause, transportAttempt)) {
              outcome = new ReviewProtocolAttemptOutcome({ kind: "transport_retrying", cause });
              await this.#sleep(this.transportRetryPolicy.delayBeforeRetry(transportAttempt));
              continue;
            }
            outcome = new ReviewProtocolAttemptOutcome({ kind: "transport_failed", cause });
            throw cause;
          }
          let value;
          try {
            value = this.contract.accept(rawResponse);
          } catch (cause) {
            const after = this.#capture(observer, attempt, transportAttempt);
            const effectEvidence = this.#effectEvidence(observer, before, after, attempt);
            if (effectEvidence !== null) {
              outcome = new ReviewProtocolAttemptOutcome({ kind: "effect_observed", cause });
              throw new ReviewProtocolFailure({ kind: "effect_observed", attempt, maxAttempts: this.retryPolicy.maxAttempts, cause, effectEvidence });
            }
            if (!this.retryPolicy.canRetryContract(attempt)) {
              outcome = new ReviewProtocolAttemptOutcome({ kind: "contract_rejected", cause });
              throw new ReviewProtocolFailure({ kind: "contract_rejected", attempt, maxAttempts: this.retryPolicy.maxAttempts, cause });
            }
            outcome = new ReviewProtocolAttemptOutcome({ kind: "contract_retrying", cause });
            retryContract = true;
            break;
          }
          // A complete, contract-valid response is admissible even if the
          // provider made a legitimate source change. Effect evidence limits
          // retries after failure/rejection; it is not a success veto.
          const after = this.#capture(observer, attempt, transportAttempt);
          outcome = new ReviewProtocolAttemptOutcome({ kind: "accepted" });
          return new ReviewProtocolResult({ attempt, rawResponse, value, before, after });
        } catch (cause) {
          if (outcome === null) {
            outcome = new ReviewProtocolAttemptOutcome({ kind: "observation_unavailable", cause });
          }
          throw cause;
        } finally {
          if (outcome !== null && settlement !== null) {
            await settlement.finalize(transportAttempt, outcome);
          }
        }
      }
      if (retryContract) continue;
    }
    throw new Error("review protocol exhausted unexpectedly");
  }

  #effectEvidence(observer, before, after, attempt) {
    try {
      if (observer === null || !observer.hasEffect(before, after)) return null;
      const evidence = observer.describe?.(before, after)
        ?? new ReviewProtocolEffectEvidence({ observer: "unspecified" });
      if (!(evidence instanceof ReviewProtocolEffectEvidence)) {
        throw new Error("review protocol observer must return ReviewProtocolEffectEvidence");
      }
      return evidence;
    } catch (cause) {
      throw new ReviewProtocolFailure({
        kind: "observation_unavailable",
        attempt,
        maxAttempts: this.retryPolicy.maxAttempts,
        cause,
        effectEvidence: new ReviewProtocolEffectEvidence({ observer: "comparison", detail: cause.message }),
      });
    }
  }

  #capture(observer, attempt, transportAttempt = null) {
    try {
      return observer?.capture(transportAttempt ?? attempt) ?? null;
    } catch (cause) {
      throw new ReviewProtocolFailure({
        kind: "observation_unavailable",
        attempt,
        maxAttempts: this.retryPolicy.maxAttempts,
        cause,
        effectEvidence: new ReviewProtocolEffectEvidence({ observer: "capture", detail: cause.message }),
      });
    }
  }

  async #sleep(delayMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
