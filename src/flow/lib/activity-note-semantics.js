/**
 * Typed Activity-note encodings whose contents participate in Flow control.
 *
 * Ordinary notes are annotation-only.  A reserved encoding is deliberately
 * kept here so every consumer can identify control notes before treating an
 * append as harmless telemetry.
 */

export const BROAD_STEPS = Object.freeze(["implement", "impl-review", "impl-gate"]);
const BROAD_MODE_LEDGER_PREFIX = "sennel.broad-mode.v1:";

/** Immutable audited broad-mode fact persisted through an Activity note. */
export class BroadModeLedgerEntry {
  constructor({ step, reason, ts, currentTaskId = null } = {}) {
    if (!BROAD_STEPS.includes(step)) throw new Error(`invalid broad mode step: ${step}`);
    if (typeof reason !== "string" || reason.trim() === "") throw new Error("broad mode reason is required");
    if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) throw new Error("broad mode timestamp is required");
    if (currentTaskId !== null && (typeof currentTaskId !== "string" || currentTaskId.trim() === "")) {
      throw new Error("broad mode currentTaskId must be null or a string");
    }
    this.step = step;
    this.reason = reason.trim();
    this.ts = ts;
    this.currentTaskId = currentTaskId;
    Object.freeze(this);
  }

  toJSON() { return { step: this.step, reason: this.reason, ts: this.ts, currentTaskId: this.currentTaskId }; }

  toActivityText() { return `${BROAD_MODE_LEDGER_PREFIX}${JSON.stringify(this.toJSON())}`; }

  /**
   * Reserve the complete encoding namespace, including malformed values.
   * A malformed control note must be treated as control-affecting until the
   * normal task-scope reader rejects it rather than being mistaken for a memo.
   */
  static isEncodedActivityNote(note) {
    return typeof note?.text === "string" && note.text.startsWith(BROAD_MODE_LEDGER_PREFIX);
  }

  static fromActivityNote(note) {
    if (!BroadModeLedgerEntry.isEncodedActivityNote(note)) return null;
    return new BroadModeLedgerEntry(JSON.parse(note.text.slice(BROAD_MODE_LEDGER_PREFIX.length)));
  }
}
