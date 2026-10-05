export class ConcurrentBatchError extends AggregateError {
  constructor(failures) {
    super(
      failures.map((failure) => failure.error),
      `${failures.length} concurrent batch item(s) failed: ${failures.map((failure) => failure.error.message).join("; ")}`,
    );
    this.name = "ConcurrentBatchError";
    this.code = "CONCURRENT_BATCH_FAILED";
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

export class ConcurrentBatchResult extends Array {
  constructor(entries = []) {
    super(...entries);
  }

  static get [Symbol.species]() {
    return Array;
  }

  throwIfErrors() {
    const failures = [];
    for (const [index, entry] of this.entries()) {
      if (entry?.error) failures.push({ index, error: entry.error });
    }
    if (failures.length > 0) throw new ConcurrentBatchError(failures);
    return this;
  }
}

/**
 * src/docs/lib/concurrency.js
 *
 * 並列実行キューユーティリティ。
 */

/**
 * items を最大 concurrency 個ずつ並列に worker で処理する。
 * 結果は入力順で返す。各要素は { value, error } 形式。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<ConcurrentBatchResult>}
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  await new Promise((resolve) => {
    let running = 0;
    let idx = 0;
    function next() {
      if (idx >= items.length && running === 0) {
        resolve();
        return;
      }
      while (running < limit && idx < items.length) {
        const itemIdx = idx++;
        running++;
        Promise.resolve(worker(items[itemIdx], itemIdx))
          .then((value) => {
            results[itemIdx] = { value, error: null };
          })
          .catch((cause) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            results[itemIdx] = { value: null, error };
          })
          .finally(() => {
            running--;
            next();
          });
      }
    }
    next();
  });
  return new ConcurrentBatchResult(results);
}
