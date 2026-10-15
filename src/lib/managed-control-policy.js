import { ExponentialBackoffPolicy } from "./exponential-backoff.js";

/** Response slots share one monotonic origin; failed connections consume their slot. */
export class ManagedControlPolicy {
  constructor({ initialMs = 2000, factor = 2, attemptCount = 3 } = {}) {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 3) {
      throw new TypeError("Managed control requires one to three response slots");
    }
    this.backoff = new ExponentialBackoffPolicy({ initialMs, factor, attemptCount });
    if (this.backoff.totalMs > 14000) throw new TypeError("Managed control exceeds its maximum budget");
    Object.freeze(this);
  }
  get attemptCount() { return this.backoff.attemptCount; }
  get budgetMs() { return this.backoff.totalMs; }
  responseDeadlineMs(ordinal) {
    let total = 0;
    for (let current = 1; current <= ordinal; current++) total += this.backoff.valueAt(current);
    return total;
  }
}

// This bounds receipt of a request. Once parsed, sender response deadlines own
// the response lifetime, so a two-second receiver timer cannot truncate it.
export const MANAGED_REQUEST_INACTIVITY_MS = 14000;
