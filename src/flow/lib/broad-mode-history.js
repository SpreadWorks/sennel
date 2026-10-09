export const BROAD_STEPS = Object.freeze(["implement", "impl-review", "impl-gate"]);
const BROAD_MODE_LEDGER_PREFIX = "sennel.broad-mode.v1:";

/** Immutable audited broad-mode fact stored as a typed Activity note. */
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
  static fromActivityNote(note) {
    if (typeof note?.text !== "string" || !note.text.startsWith(BROAD_MODE_LEDGER_PREFIX)) return null;
    return new BroadModeLedgerEntry(JSON.parse(note.text.slice(BROAD_MODE_LEDGER_PREFIX.length)));
  }
}

export function broadModeHistory(state) {
  return (Array.isArray(state?.notes) ? state.notes : [])
    .map((note) => BroadModeLedgerEntry.fromActivityNote(note))
    .filter((entry) => entry !== null)
    .map((entry) => entry.toJSON());
}


export function buildBoundedBroadModeHistory(state, limit) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  const history = broadModeHistory(state);
  const entries = history.slice(-max).map((entry) => ({
    step: entry.step,
    reason: entry.reason,
    ts: entry.ts,
    currentTaskId: entry.currentTaskId ?? null,
  }));
  return {
    entries,
    total: history.length,
    truncated: Math.max(0, history.length - entries.length),
  };
}
