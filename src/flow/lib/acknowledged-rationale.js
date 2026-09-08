import { guardrailAllowsAcknowledgedException } from "../../lib/guardrail.js";

const MAX_ENTRIES_PER_GUARDRAIL = 3;
const MAX_ENTRY_TEXT_CHARS = 600;
const MAX_SECTION_CHARS = 4000;
const DEFAULT_HEADING = "Matched Spec Acknowledgment Rationale";
const UNAVAILABLE_WARNING = "parent spec context unavailable";

const APPROVED_EXCEPTION_MINT = Symbol("approved-finding-exception");

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isIdChar(char) {
  return /^[A-Za-z0-9-]$/.test(char);
}

function guardrailIdMatches(text, guardrailId) {
  const matches = [];
  let start = 0;
  while (start < text.length) {
    const idx = text.indexOf(guardrailId, start);
    if (idx < 0) break;
    const prev = idx === 0 ? "" : text[idx - 1];
    const nextIdx = idx + guardrailId.length;
    const next = nextIdx >= text.length ? "" : text[nextIdx];
    if ((!prev || !isIdChar(prev)) && (!next || !isIdChar(next))) {
      matches.push([idx, nextIdx]);
    }
    start = idx + guardrailId.length;
  }
  return matches;
}

function hasGuardrailId(text, guardrailId) {
  return guardrailIdMatches(text, guardrailId).length > 0;
}

function removeMatchedGuardrailIds(text, guardrailId) {
  const matches = guardrailIdMatches(text, guardrailId);
  if (matches.length === 0) return text;
  let out = "";
  let last = 0;
  for (const [start, end] of matches) {
    out += text.slice(last, start);
    last = end;
  }
  out += text.slice(last);
  return out;
}

function qualifies(text, guardrailId) {
  if (!hasGuardrailId(text, guardrailId)) return false;
  const withoutIds = removeMatchedGuardrailIds(text, guardrailId);
  return withoutIds.replace(/\s/g, "").length >= 20;
}

function truncateText(text) {
  if (text.length <= MAX_ENTRY_TEXT_CHARS) {
    return { text, truncated: false };
  }
  const marker = " [truncated]";
  return {
    text: text.slice(0, MAX_ENTRY_TEXT_CHARS - marker.length).trimEnd() + marker,
    truncated: true,
  };
}

class AcknowledgedRationaleEntry {
  constructor(guardrailId, sourcePath, text, truncated = false) {
    if (!guardrailId) throw new Error("guardrailId is required");
    if (!sourcePath) throw new Error("sourcePath is required");
    const normalized = normalizeText(text);
    if (!normalized) throw new Error("text is required");
    this.guardrailId = guardrailId;
    this.sourcePath = sourcePath;
    this.text = normalized;
    this.truncated = Boolean(truncated);
  }

  toPromptLines() {
    return [
      `- source: ${this.sourcePath}`,
      `  text: ${this.text}${this.truncated && !this.text.endsWith("[truncated]") ? " [truncated]" : ""}`,
    ];
  }

  toMarkdown() {
    return this.toPromptLines().join("\n");
  }
}

class AcknowledgedRationaleSet {
  constructor(guardrails) {
    this.guardrails = Array.isArray(guardrails) ? guardrails : [];
    this.entriesByGuardrail = new Map(this.guardrails.map((g) => [g.id, []]));
  }

  addEntry(guardrailId, sourcePath, text) {
    const entries = this.entriesByGuardrail.get(guardrailId);
    if (!entries || entries.length >= MAX_ENTRIES_PER_GUARDRAIL) return;
    const truncated = truncateText(normalizeText(text));
    entries.push(new AcknowledgedRationaleEntry(
      guardrailId,
      sourcePath,
      truncated.text,
      truncated.truncated,
    ));
  }

  entriesFor(guardrailId) {
    return this.entriesByGuardrail.get(guardrailId) || [];
  }

  toMarkdown(heading = DEFAULT_HEADING) {
    let markdown = `## ${heading}`;
    let renderedEntries = 0;
    for (const guardrail of this.guardrails) {
      const entries = this.entriesFor(guardrail.id);
      if (entries.length === 0) continue;
      let guardrailStarted = false;
      for (const entry of entries) {
        const prefix = guardrailStarted ? "\n" : `\n\n### ${guardrail.id}\n`;
        const addition = `${prefix}${entry.toMarkdown()}`;
        if (markdown.length + addition.length > MAX_SECTION_CHARS) {
          return renderedEntries === 0 ? "" : markdown;
        }
        markdown += addition;
        renderedEntries += 1;
        guardrailStarted = true;
      }
    }
    return renderedEntries === 0 ? "" : markdown;
  }

  static fromSpec(spec, guardrails) {
    const set = new AcknowledgedRationaleSet(guardrails);
    if (!spec) return set;
    for (const guardrail of guardrails || []) {
      set.collectForGuardrail(spec, guardrail.id);
    }
    return set;
  }

  collectForGuardrail(spec, guardrailId) {
    const constraints = Array.isArray(spec.constraints) ? spec.constraints : [];
    for (let i = 0; i < constraints.length; i++) {
      const text = normalizeText(constraints[i]);
      if (qualifies(text, guardrailId)) {
        this.addEntry(guardrailId, `$.constraints[${i}]`, text);
      }
    }

    const clarifications = Array.isArray(spec.clarifications) ? spec.clarifications : [];
    for (let i = 0; i < clarifications.length; i++) {
      const q = normalizeText(clarifications[i]?.q);
      const a = normalizeText(clarifications[i]?.a);
      const combined = normalizeText(`${q} ${a}`);
      if (qualifies(combined, guardrailId)) {
        this.addEntry(guardrailId, `$.clarifications[${i}]`, `Q: ${q} A: ${a}`);
      }
    }

    const alternatives = Array.isArray(spec.alternatives_considered)
      ? spec.alternatives_considered
      : [];
    for (let i = 0; i < alternatives.length; i++) {
      const option = normalizeText(alternatives[i]?.option);
      const reason = normalizeText(alternatives[i]?.reason);
      const combined = normalizeText(`${option} ${reason}`);
      if (qualifies(combined, guardrailId)) {
        this.addEntry(
          guardrailId,
          `$.alternatives_considered[${i}]`,
          `Option: ${option} Reason: ${reason}`,
        );
      }
    }
  }
}

/** Canonical spec acknowledgment paired with a guardrail that permits it. */
export class ApprovedFindingException {
  constructor({ guardrailId, sources }, mint = null) {
    if (mint !== APPROVED_EXCEPTION_MINT) throw new Error("approved finding exceptions require canonical authority");
    this.guardrailId = String(guardrailId);
    this.sources = Object.freeze(sources.map((entry) => entry.sourcePath));
    Object.freeze(this);
  }

  toJSON() { return { guardrailId: this.guardrailId, sources: [...this.sources] }; }
}

/** Parent-derived exception authority; workers can inspect but cannot mint it. */
export class ApprovedFindingExceptionSet {
  constructor(entries = [], mint = null) {
    if (mint !== APPROVED_EXCEPTION_MINT) throw new Error("approved finding exception sets require canonical authority");
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  static fromCanonical({ spec, guardrails = [] } = {}) {
    const rationale = AcknowledgedRationaleSet.fromSpec(spec, guardrails);
    const entries = guardrails
      .filter((guardrail) => guardrailAllowsAcknowledgedException(guardrail))
      .map((guardrail) => ({ guardrailId: guardrail.id, sources: rationale.entriesFor(guardrail.id) }))
      .filter((entry) => entry.sources.length > 0)
      .map((entry) => new ApprovedFindingException(entry, APPROVED_EXCEPTION_MINT));
    return new ApprovedFindingExceptionSet(entries, APPROVED_EXCEPTION_MINT);
  }

  allows(finding) {
    return typeof finding?.guardrailId === "string"
      && this.entries.some((entry) => entry.guardrailId === finding.guardrailId);
  }

  toJSON() { return { version: 1, exceptions: this.entries.map((entry) => entry.toJSON()) }; }
}

function buildAcknowledgedRationaleSection({ spec, guardrails, heading = DEFAULT_HEADING }) {
  if (!spec) return { markdown: "", warning: UNAVAILABLE_WARNING };
  const set = AcknowledgedRationaleSet.fromSpec(spec, guardrails || []);
  return { markdown: set.toMarkdown(heading), warning: "" };
}

export {
  AcknowledgedRationaleEntry,
  AcknowledgedRationaleSet,
  buildAcknowledgedRationaleSection,
};
