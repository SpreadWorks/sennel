/** Finite exponential time values; callers retain retry and execution authority. */
export class ExponentialBackoffPolicy {
  #totalMs;
  constructor({ initialMs, factor = 2, attemptCount }) {
    if (!Number.isSafeInteger(initialMs) || initialMs <= 0) throw new TypeError("Exponential backoff initialMs must be a positive safe integer");
    if (!Number.isFinite(factor) || factor < 1) throw new TypeError("Exponential backoff factor must be at least one");
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new TypeError("Exponential backoff attemptCount must be a non-negative safe integer");
    const totalMs = attemptCount === 0 ? 0 : initialMs * (factor === 1 ? attemptCount : (Math.pow(factor, attemptCount) - 1) / (factor - 1));
    if (!Number.isFinite(totalMs) || totalMs > Number.MAX_SAFE_INTEGER) throw new TypeError("Exponential backoff exceeds its finite time budget");
    this.initialMs = initialMs;
    this.factor = factor;
    this.attemptCount = attemptCount;
    this.#totalMs = totalMs;
    Object.freeze(this);
  }

  get totalMs() { return this.#totalMs; }

  valueAt(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > this.attemptCount) throw new TypeError("Exponential backoff attempt is outside its bounded policy");
    return this.initialMs * Math.pow(this.factor, number - 1);
  }
}
