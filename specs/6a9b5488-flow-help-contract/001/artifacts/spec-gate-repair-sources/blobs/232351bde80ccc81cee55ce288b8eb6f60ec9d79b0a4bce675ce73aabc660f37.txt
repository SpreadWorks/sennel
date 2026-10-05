/** Deterministic, localized full Markdown renderers for human Flow review. */

import { createI18n } from "../../lib/i18n.js";
import {
  ArtifactViewDocument,
  ArtifactViewResolvedReference,
} from "./artifact-view-reader.js";
import { MechanicalBlocker } from "./acceptance-review-artifacts.js";
import { artifactViewSha256, stableArtifactViewJson } from "./artifact-view-fingerprint.js";

const DEFAULT_MESSAGES = Object.freeze({
  titleSpec: "Specification",
  titleAcceptance: "Acceptance review",
  goal: "Goal",
  background: "Background",
  scope: "Scope",
  inScope: "In scope",
  outOfScope: "Out of scope",
  constraints: "Constraints",
  designPrinciples: "Design principles",
  overview: "Overview",
  modules: "Modules",
  dataFlow: "Data flow",
  decisions: "Decisions",
  evidence: "Evidence",
  alternatives: "Alternatives considered",
  clarifications: "Clarifications",
  requirements: "Requirements",
  requirement: "Requirement",
  acceptanceCriteria: "Acceptance criteria",
  testable: "Testable",
  implementationTargets: "Implementation targets",
  keywords: "Keywords",
  openQuestions: "Open questions",
  approval: "Approval",
  approved: "Approved",
  notApproved: "Not approved",
  confirmedAt: "Confirmed at",
  notes: "Notes",
  tasks: "Tasks",
  task: "Task",
  purpose: "Purpose",
  question: "Question",
  answer: "Answer",
  status: "Status",
  parent: "Parent task",
  children: "Child tasks",
  origin: "Origin",
  addedRound: "Added round",
  implementationNotes: "Implementation notes",
  testStrategy: "Test strategy",
  noItems: "None",
  acceptanceVerdict: "Acceptance verdict",
  decision: "Decision",
  undecided: "Undecided",
  acceptRisk: "Accept risk and continue",
  abort: "Abort",
  decidedAt: "Decided at",
  requirementJudgments: "Requirement judgments",
  judgment: "Judgment",
  met: "Met",
  notMet: "Not met",
  notVerifiable: "Not verifiable",
  evidenceReferences: "Evidence references",
  missingEvidence: "Missing evidence",
  mechanicalBlockers: "Mechanical blockers",
  hardBlockers: "Hard blockers",
  hardBlocker: "Hard blocker",
  deferredFindings: "Deferred findings",
  deferredFinding: "Deferred finding",
  originalFinding: "Original finding",
  sourceStep: "Source step",
  target: "Target",
  findingIssue: "Issue",
  findingDetail: "Detail",
  requiredChange: "Required change",
  rationale: "Rationale",
  impact: "Impact or risk",
  location: "Location",
  recommendation: "Recommendation",
  improvement: "Improvement",
  findingEvidence: "Evidence",
  result: "Result",
  disposition: "Disposition",
  requirementId: "Requirement",
  guardrailId: "Guardrail",
  summary: "Summary",
  finalDisposition: "Final disposition",
  remainingRisks: "Remaining risks",
  remainingRisk: "Remaining risk",
  source: "Source",
  detail: "Detail",
  kind: "Kind",
  id: "ID",
  riskFromRequirement: "Requirement requires a decision or repair",
  riskFromBlocker: "Blocker remains unresolved",
  riskFromFinding: "Deferred finding remains unresolved",
  verdictPass: "Pass",
  verdictRepairRequired: "Repair required",
  verdictUserDecisionRequired: "User decision required",
  verdictBlocked: "Blocked",
  cacheNotSaved: "The artifact view was generated but its cache could not be saved.",
});

/** Locale table contract for all fixed artifact-view labels and diagnostics. */
export const ARTIFACT_VIEW_LOCALIZATION_KEYS = Object.freeze(Object.keys(DEFAULT_MESSAGES));

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function digest(value) {
  return artifactViewSha256(stableArtifactViewJson(value));
}

function rawText(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function rawList(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value !== "") : [];
}

function bulletLines(values, empty) {
  const items = rawList(values);
  return items.length === 0 ? `- ${empty}\n` : items.map((item) => `- ${item}\n`).join("");
}

function sourceText(values) {
  return values.filter((value) => typeof value === "string" && value !== "").join("\n");
}

function labeledLine(label, value, empty) {
  const rendered = rawText(value) ?? empty;
  return `- **${label}**: ${rendered}\n`;
}

function statusLabel(localizer, value) {
  const byStatus = {
    met: "met",
    notMet: "notMet",
    notVerifiable: "notVerifiable",
    pass: "verdictPass",
    repair_required: "verdictRepairRequired",
    user_decision_required: "verdictUserDecisionRequired",
    blocked: "verdictBlocked",
  };
  return localizer.message(byStatus[value] ?? "status").replace("{{value}}", String(value));
}

function knownText(value) {
  if (typeof value === "string" && value.trim() !== "") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => knownText(entry));
  return [];
}

function fields(value, names) {
  return names.flatMap((name) => knownText(value?.[name]));
}

function unique(values) {
  return [...new Set(values)];
}

function knownLocation(value = {}) {
  const direct = fields(value, ["file", "path", "locationPath", "target", "where"]);
  const positions = [value.location, value.target, value.where].flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim() !== "") return [candidate];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const file = fields(candidate, ["file", "path", "source", "target"]);
    const line = Number.isSafeInteger(candidate.line) ? String(candidate.line) : null;
    const column = Number.isSafeInteger(candidate.column) ? String(candidate.column) : null;
    return file.map((entry) => (
      line === null ? entry : `${entry}:${line}${column === null ? "" : `:${column}`}`
    ));
  });
  return unique([...direct, ...positions]);
}

/** A narrowly typed, user-relevant projection of an original review finding. */
export class ArtifactViewFindingDetail {
  constructor(finding = {}) {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("artifact view original finding must be an object");
    }
    this.issue = Object.freeze(unique(fields(finding, ["issue", "summary", "title", "message"])));
    this.detail = Object.freeze(unique(fields(finding, ["detail", "details", "body", "description"])));
    this.requiredChange = Object.freeze(unique(fields(finding, ["requiredChange"])));
    this.rationale = Object.freeze(unique(fields(finding, ["rationale", "reason", "whyBlocking", "whyNonBlocking", "why_violates"])));
    this.impact = Object.freeze(unique(fields(finding, ["impact", "risk", "severity", "failureMode", "failureKind"])));
    this.location = Object.freeze(knownLocation(finding));
    this.evidence = Object.freeze(unique(fields(finding, ["evidenceRefs", "refs", "evidence", "references"])));
    this.recommendation = Object.freeze(unique(fields(finding, ["recommendation", "proposal", "suggestedFix", "nextAction", "suggestion"])));
    this.improvement = Object.freeze(unique(fields(finding, ["improvement"])));
    this.result = Object.freeze(unique(fields(finding, ["result", "verdict", "outcome", "disposition"])));
    this.requirementIds = Object.freeze(unique(fields(finding, ["requirementId", "requirement_id"])));
    this.guardrailIds = Object.freeze(unique(fields(finding, ["guardrailId", "guardrail_id"])));
    if ([
      this.issue, this.detail, this.requiredChange, this.rationale, this.impact,
      this.location, this.evidence, this.recommendation, this.improvement,
      this.result, this.requirementIds, this.guardrailIds,
    ].every((entries) => entries.length === 0)) {
      throw new Error("artifact view original finding has no displayable finding detail");
    }
    Object.freeze(this);
  }

  sourceText() {
    return sourceText([
      ...this.issue, ...this.detail, ...this.requiredChange, ...this.rationale,
      ...this.impact, ...this.location, ...this.evidence, ...this.recommendation,
      ...this.improvement, ...this.result, ...this.requirementIds, ...this.guardrailIds,
    ]);
  }

  toMarkdown(localizer) {
    const lines = [];
    const section = (label, values) => {
      if (values.length === 0) return;
      lines.push(`- **${localizer.message(label)}**:\n`);
      lines.push(values.map((value) => `  - ${value}\n`).join(""));
    };
    section("findingIssue", this.issue);
    section("findingDetail", this.detail);
    section("requiredChange", this.requiredChange);
    section("rationale", this.rationale);
    section("impact", this.impact);
    section("location", this.location);
    section("findingEvidence", this.evidence);
    section("recommendation", this.recommendation);
    section("improvement", this.improvement);
    section("result", this.result);
    section("requirementId", this.requirementIds);
    section("guardrailId", this.guardrailIds);
    return lines.join("");
  }

  riskSummary(fallback) {
    return this.impact[0]
      ?? this.issue[0]
      ?? this.detail[0]
      ?? this.requiredChange[0]
      ?? this.rationale[0]
      ?? this.recommendation[0]
      ?? this.improvement[0]
      ?? fallback;
  }
}

/** The known deferred-finding projection carried by acceptance.review. */
export class ArtifactViewDeferredFinding {
  constructor(value = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("artifact view deferred finding must be an object");
    }
    this.findingId = text(value.findingId, "artifact view deferred findingId");
    this.sourceStep = text(value.sourceStep, "artifact view deferred sourceStep");
    this.sourceArtifact = text(value.sourceArtifact, "artifact view deferred sourceArtifact");
    this.sourceFindingId = text(value.sourceFindingId, "artifact view deferred sourceFindingId");
    this.finalDisposition = text(value.finalDisposition, "artifact view deferred finalDisposition");
    if (!["fixed", "not_needed", "false_positive", "pre_existing", "still_open", "blocking"].includes(this.finalDisposition)) {
      throw new Error("artifact view deferred finalDisposition is invalid");
    }
    Object.freeze(this);
  }

  assertReference(reference) {
    if (!(reference instanceof ArtifactViewResolvedReference)) {
      throw new Error("artifact view deferred finding requires a resolved reference");
    }
    if (
      reference.findingId !== this.findingId
      || reference.sourceStep !== this.sourceStep
      || reference.sourceArtifact !== this.sourceArtifact
      || reference.sourceFindingId !== this.sourceFindingId
    ) {
      throw new Error(`artifact view deferred finding source is not linked: ${this.findingId}`);
    }
    return reference;
  }
}

/** A localized fixed-text provider whose revision reflects exactly used view messages. */
export class ArtifactViewLocalizer {
  constructor({ config = {}, root = null, i18n = null } = {}) {
    const lang = typeof config?.lang === "string" && config.lang.trim() !== "" ? config.lang : "en";
    if (i18n !== null && typeof i18n !== "function") throw new Error("artifact view i18n must be a function or null");
    this.lang = lang;
    this.translate = i18n || createI18n(lang, {
      domain: "messages",
      // `createI18n()` requires a truthy presetTypes option before it uses a
      // project root. An empty preset list is meaningful here: it enables a
      // project's .sennel/locale override even when no preset type is set.
      ...(root ? { projectRoot: root, presetTypes: config?.type ?? [] } : {}),
    });
    const messages = {};
    for (const key of ARTIFACT_VIEW_LOCALIZATION_KEYS) messages[key] = this.message(key);
    this.revision = digest({ lang: this.lang, messages });
    Object.freeze(this);
  }

  message(key, params = undefined) {
    const normalized = text(key, "artifact view message key");
    const defaultValue = DEFAULT_MESSAGES[normalized];
    if (defaultValue === undefined) throw new Error(`unknown artifact view message key: ${normalized}`);
    const translated = this.translate(`artifactView.${normalized}`, params);
    if (translated === `artifactView.${normalized}`) return defaultValue;
    return translated;
  }
}

/** One ordered Markdown range, with source-aware metadata for summary contracts. */
export class ArtifactViewSemanticUnit {
  constructor({ id, kind, order, markdown, start, end, sourceText: original = null, requirementId = null, taskId = null, judgmentStatus = null, status = null, findingId = null, blockerId = null, riskId = null, identity = null, risk = false } = {}) {
    this.id = text(id, "artifact view semantic unit id");
    this.kind = text(kind, "artifact view semantic unit kind");
    if (!Number.isSafeInteger(order) || order < 0) throw new Error("artifact view semantic unit order must be a non-negative integer");
    this.order = order;
    if (typeof markdown !== "string" || markdown === "") throw new Error("artifact view semantic unit markdown must be non-empty");
    this.markdown = markdown;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start !== markdown.length) {
      throw new Error("artifact view semantic unit range must exactly cover its markdown");
    }
    this.range = Object.freeze({ start, end });
    this.sourceText = original == null ? null : String(original);
    this.requirementId = requirementId == null ? null : text(requirementId, "artifact view semantic unit requirementId");
    this.taskId = taskId == null ? null : text(taskId, "artifact view semantic unit taskId");
    this.judgmentStatus = judgmentStatus == null ? null : text(judgmentStatus, "artifact view semantic unit judgmentStatus");
    this.findingId = findingId == null ? null : text(findingId, "artifact view semantic unit findingId");
    this.blockerId = blockerId == null ? null : text(blockerId, "artifact view semantic unit blockerId");
    this.riskId = riskId == null ? null : text(riskId, "artifact view semantic unit riskId");
    this.identity = identity == null
      ? (this.requirementId ?? this.taskId ?? this.findingId ?? this.blockerId ?? this.riskId)
      : text(identity, "artifact view semantic unit identity");
    this.status = status == null
      ? this.judgmentStatus
      : text(status, "artifact view semantic unit status");
    if (risk !== true && risk !== false) throw new Error("artifact view semantic unit risk must be boolean");
    this.risk = risk;
    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      order: this.order,
      markdown: this.markdown,
      range: { ...this.range },
      ...(this.sourceText === null ? {} : { sourceText: this.sourceText }),
      ...(this.requirementId === null ? {} : { requirementId: this.requirementId }),
      ...(this.taskId === null ? {} : { taskId: this.taskId }),
      ...(this.judgmentStatus === null ? {} : { judgmentStatus: this.judgmentStatus }),
      ...(this.findingId === null ? {} : { findingId: this.findingId }),
      ...(this.blockerId === null ? {} : { blockerId: this.blockerId }),
      ...(this.riskId === null ? {} : { riskId: this.riskId }),
      ...(this.identity === null ? {} : { identity: this.identity }),
      ...(this.status === null ? {} : { status: this.status }),
      ...(this.risk ? { risk: true } : {}),
    };
  }
}

class SemanticUnitBuilder {
  constructor() {
    this.parts = [];
    this.offset = 0;
  }

  add(input) {
    const markdown = input.markdown;
    const unit = new ArtifactViewSemanticUnit({
      ...input,
      order: this.parts.length,
      start: this.offset,
      end: this.offset + markdown.length,
    });
    this.parts.push(unit);
    this.offset += markdown.length;
    return unit;
  }

  units() { return Object.freeze([...this.parts]); }
  markdown() { return this.parts.map((unit) => unit.markdown).join(""); }
}

/** Rendered full display plus exact semantic-unit reconstruction metadata. */
export class ArtifactFullView {
  constructor({ document, localizer, semanticUnits } = {}) {
    if (!(document instanceof ArtifactViewDocument)) throw new Error("artifact full view requires an ArtifactViewDocument");
    if (!(localizer instanceof ArtifactViewLocalizer)) throw new Error("artifact full view requires an ArtifactViewLocalizer");
    if (!Array.isArray(semanticUnits) || semanticUnits.some((unit) => !(unit instanceof ArtifactViewSemanticUnit))) {
      throw new Error("artifact full view requires ArtifactViewSemanticUnit values");
    }
    const markdown = semanticUnits.map((unit) => unit.markdown).join("");
    if (new Set(semanticUnits.map((unit) => unit.id)).size !== semanticUnits.length) {
      throw new Error("artifact full view semantic unit ids must be unique");
    }
    let offset = 0;
    for (const [index, unit] of semanticUnits.entries()) {
      if (unit.order !== index || unit.range.start !== offset || unit.range.end !== offset + unit.markdown.length) {
        throw new Error("artifact full view semantic units must be contiguous and ordered");
      }
      offset += unit.markdown.length;
    }
    if (!markdown.endsWith("\n")) throw new Error("artifact full view markdown must end with a newline");
    this.document = document;
    this.logicalKey = document.entry.logicalKey;
    this.markdown = markdown;
    this.semanticUnits = Object.freeze([...semanticUnits]);
    this.sourceArtifacts = document.sourceArtifacts;
    this.language = localizer.lang;
    this.rendererRevision = document.entry.rendererRevision;
    this.i18nRevision = localizer.revision;
    Object.freeze(this);
  }

  sourceFingerprintInputs() { return this.document.fingerprintSources(); }
}

/** Dedicated non-AI renderer; it only accepts a catalog-verified document. */
export class ArtifactFullViewRenderer {
  constructor({ config = {}, root = null, i18n = null } = {}) {
    this.localizer = new ArtifactViewLocalizer({ config, root, i18n });
    Object.freeze(this);
  }

  render(document) {
    if (!(document instanceof ArtifactViewDocument)) throw new Error("artifact full renderer requires an ArtifactViewDocument");
    const builder = new SemanticUnitBuilder();
    if (document.logicalKey === "spec.record") this.#renderSpec(document, builder);
    else if (document.logicalKey === "acceptance.review") this.#renderAcceptance(document, builder);
    else throw new Error(`artifact full renderer does not support ${document.logicalKey}`);
    return new ArtifactFullView({ document, localizer: this.localizer, semanticUnits: builder.units() });
  }

  #renderSpec(document, builder) {
    const t = this.localizer;
    const spec = document.primaryValue;
    builder.add({
      id: "spec.header",
      kind: "header",
      markdown: `# ${t.message("titleSpec")}\n\n`,
    });
    builder.add({
      id: "spec.purpose",
      kind: "purpose",
      markdown: `## ${t.message("goal")}\n${rawText(spec.goal) ?? t.message("noItems")}\n\n`,
      sourceText: rawText(spec.goal),
    });
    builder.add({
      id: "spec.background",
      kind: "background",
      markdown: `## ${t.message("background")}\n${rawText(spec.background) ?? t.message("noItems")}\n\n`,
      sourceText: rawText(spec.background),
    });
    builder.add({
      id: "spec.scope",
      kind: "scope",
      markdown: `## ${t.message("scope")}\n### ${t.message("inScope")}\n${bulletLines(spec.scope?.in, t.message("noItems"))}\n### ${t.message("outOfScope")}\n${bulletLines(spec.scope?.out, t.message("noItems"))}\n`,
      sourceText: sourceText([...(spec.scope?.in || []), ...(spec.scope?.out || [])]),
    });
    builder.add({
      id: "spec.constraints",
      kind: "constraints",
      markdown: `## ${t.message("constraints")}\n${bulletLines(spec.constraints, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.constraints || []),
    });
    builder.add({
      id: "spec.design-principles",
      kind: "designPrinciples",
      markdown: `## ${t.message("designPrinciples")}\n${bulletLines(spec.design_principles, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.design_principles || []),
    });
    builder.add({
      id: "spec.overview",
      kind: "overview",
      markdown: this.#renderOverview(spec.overview, t),
      sourceText: sourceText([
        ...(spec.overview?.modules || []).map((entry) => entry.text),
        ...(spec.overview?.data_flow || []).map((entry) => entry.text),
        ...(spec.overview?.decisions || []).flatMap((entry) => [entry.text, entry.evidence, entry.consideredAlternatives]),
      ]),
    });
    builder.add({
      id: "spec.clarifications",
      kind: "clarifications",
      markdown: this.#renderClarifications(spec.clarifications, t),
      sourceText: sourceText((spec.clarifications || []).flatMap((entry) => [entry.q, entry.a])),
    });
    builder.add({
      id: "spec.alternatives",
      kind: "alternatives",
      markdown: this.#renderAlternatives(spec.alternatives_considered, t),
      sourceText: sourceText((spec.alternatives_considered || []).flatMap((entry) => [entry.option, entry.reason])),
    });
    builder.add({
      id: "spec.approval",
      kind: "approval",
      markdown: this.#renderApproval(spec.user_approval, t),
      sourceText: sourceText([spec.user_approval?.confirmed_at, spec.user_approval?.notes]),
    });
    builder.add({
      id: "spec.requirements-heading",
      kind: "requirementsHeading",
      markdown: `## ${t.message("requirements")}\n\n`,
    });
    for (const requirement of spec.requirements) {
      builder.add({
        id: `spec.requirement.${requirement.id}`,
        kind: "requirement",
        requirementId: requirement.id,
        markdown: this.#renderRequirement(requirement, t),
        sourceText: sourceText([requirement.id, requirement.desc, requirement.priority]),
      });
    }
    builder.add({
      id: "spec.acceptance-criteria",
      kind: "acceptanceCriteria",
      markdown: `## ${t.message("acceptanceCriteria")}\n${bulletLines(spec.acceptance_criteria, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.acceptance_criteria || []),
    });
    builder.add({
      id: "spec.implementation-targets",
      kind: "implementationTargets",
      markdown: `## ${t.message("implementationTargets")}\n${bulletLines(spec.implementationTargets, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.implementationTargets || []),
    });
    builder.add({
      id: "spec.keywords",
      kind: "keywords",
      markdown: `## ${t.message("keywords")}\n${bulletLines(spec.keywords, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.keywords || []),
    });
    builder.add({
      id: "spec.open-questions",
      kind: "openQuestions",
      markdown: `## ${t.message("openQuestions")}\n${bulletLines(spec.open_questions, t.message("noItems"))}\n`,
      sourceText: sourceText(spec.open_questions || []),
    });
    builder.add({
      id: "spec.tasks-heading",
      kind: "tasksHeading",
      markdown: `## ${t.message("tasks")}\n\n`,
    });
    const children = new Map();
    for (const task of spec.tasks || []) {
      if (task.parent === null || task.parent === undefined) continue;
      const list = children.get(task.parent) || [];
      list.push(task.id);
      children.set(task.parent, list);
    }
    if ((spec.tasks || []).length === 0) {
      builder.add({ id: "spec.tasks.empty", kind: "emptyTasks", markdown: `- ${t.message("noItems")}\n`, sourceText: "" });
    } else {
      for (const task of spec.tasks) {
        builder.add({
          id: `spec.task.${task.id}`,
          kind: "task",
          taskId: task.id,
          markdown: this.#renderTask(task, children.get(task.id) || [], t),
          sourceText: sourceText([
            task.id, task.title, task.goal, ...(task.acceptance || []), task.implementation_notes,
            task.test_strategy, task.parent, task.origin, task.status,
          ]),
        });
      }
    }
  }

  #renderOverview(overview, t) {
    const modules = overview?.modules || [];
    const dataFlow = overview?.data_flow || [];
    const decisions = overview?.decisions || [];
    const lines = [`## ${t.message("overview")}\n`, `### ${t.message("modules")}\n`];
    lines.push(modules.length === 0 ? `- ${t.message("noItems")}\n` : modules.map((entry) => `- ${entry.text}\n`).join(""));
    lines.push(`\n### ${t.message("dataFlow")}\n`);
    lines.push(dataFlow.length === 0 ? `- ${t.message("noItems")}\n` : dataFlow.map((entry) => `- ${entry.text}\n`).join(""));
    lines.push(`\n### ${t.message("decisions")}\n`);
    if (decisions.length === 0) lines.push(`- ${t.message("noItems")}\n`);
    else {
      for (const entry of decisions) {
        lines.push(`- ${entry.text}\n`);
        if (rawText(entry.evidence)) lines.push(`  - **${t.message("evidence")}**: ${entry.evidence}\n`);
        if (rawText(entry.consideredAlternatives)) lines.push(`  - **${t.message("alternatives")}**: ${entry.consideredAlternatives}\n`);
      }
    }
    lines.push("\n");
    return lines.join("");
  }

  #renderClarifications(entries, t) {
    const lines = [`## ${t.message("clarifications")}\n`];
    if (!Array.isArray(entries) || entries.length === 0) lines.push(`- ${t.message("noItems")}\n`);
    else for (const entry of entries) lines.push(`- **${t.message("question")}**: ${entry.q}\n  - **${t.message("answer")}**: ${entry.a}\n`);
    lines.push("\n");
    return lines.join("");
  }

  #renderAlternatives(entries, t) {
    const lines = [`## ${t.message("alternatives")}\n`];
    if (!Array.isArray(entries) || entries.length === 0) lines.push(`- ${t.message("noItems")}\n`);
    else for (const entry of entries) lines.push(`- **${entry.option}**: ${entry.reason}\n`);
    lines.push("\n");
    return lines.join("");
  }

  #renderApproval(approval, t) {
    const approved = approval?.approved === true;
    const lines = [`## ${t.message("approval")}\n`, `- **${t.message("status")}**: ${approved ? t.message("approved") : t.message("notApproved")}\n`];
    if (approved) {
      lines.push(labeledLine(t.message("confirmedAt"), approval.confirmed_at, t.message("noItems")));
      lines.push(labeledLine(t.message("notes"), approval.notes, t.message("noItems")));
    }
    lines.push("\n");
    return lines.join("");
  }

  #renderRequirement(requirement, t) {
    const labels = [];
    if (rawText(requirement.priority)) labels.push(requirement.priority);
    const suffix = labels.length === 0 ? "" : ` (${labels.join(", ")})`;
    const testable = requirement.testable === undefined ? "" : `\n- **${t.message("testable")}**: ${String(requirement.testable)}`;
    return `### ${t.message("requirement")} ${requirement.id}${suffix}\n${requirement.desc}${testable}\n\n`;
  }

  #renderTask(task, childIds, t) {
    const lines = [
      `### ${t.message("task")} ${task.id}: ${task.title}\n`,
      `#### ${t.message("purpose")}\n${task.goal}\n\n`,
    ];
    lines.push(labeledLine(t.message("status"), task.status, t.message("noItems")));
    lines.push(labeledLine(t.message("parent"), task.parent, t.message("noItems")));
    lines.push(labeledLine(t.message("children"), childIds.length > 0 ? childIds.join(", ") : null, t.message("noItems")));
    lines.push(labeledLine(t.message("origin"), task.origin, t.message("noItems")));
    lines.push(labeledLine(t.message("addedRound"), String(task.added_round), t.message("noItems")));
    lines.push(`\n#### ${t.message("acceptanceCriteria")}\n${bulletLines(task.acceptance, t.message("noItems"))}\n`);
    lines.push(`#### ${t.message("implementationNotes")}\n${rawText(task.implementation_notes) ?? t.message("noItems")}\n\n`);
    lines.push(`#### ${t.message("testStrategy")}\n${rawText(task.test_strategy) ?? t.message("noItems")}\n\n`);
    return lines.join("");
  }

  #renderAcceptance(document, builder) {
    const t = this.localizer;
    const review = document.primaryValue;
    const spec = JSON.parse(document.dependency("spec.record").text());
    const requirements = new Map(spec.requirements.map((entry) => [entry.id, entry]));
    const referenceByFindingId = new Map(document.references.map((reference) => [reference.findingId, reference]));
    builder.add({
      id: "acceptance.header",
      kind: "header",
      markdown: `# ${t.message("titleAcceptance")}\n\n## ${t.message("acceptanceVerdict")}\n${statusLabel(t, review.verdict)}\n\n`,
      sourceText: review.verdict,
    });
    builder.add({
      id: "acceptance.decision",
      kind: "decision",
      markdown: this.#renderDecision(document.decision, t),
      sourceText: document.decision === null ? null : sourceText([document.decision.choice, document.decision.decidedAt]),
    });
    builder.add({ id: "acceptance.judgments-heading", kind: "judgmentsHeading", markdown: `## ${t.message("requirementJudgments")}\n\n` });
    for (const judgment of review.requirementJudgments) {
      const requirement = requirements.get(judgment.requirementId);
      if (!requirement) throw new Error(`acceptance renderer cannot resolve requirement: ${judgment.requirementId}`);
      builder.add({
        id: `acceptance.judgment.${judgment.requirementId}`,
        kind: "requirementJudgment",
        requirementId: judgment.requirementId,
        judgmentStatus: judgment.status,
        status: judgment.status,
        markdown: this.#renderJudgment(judgment, requirement, t),
        sourceText: sourceText([requirement.id, requirement.desc, ...judgment.missingEvidence, ...judgment.requestRefs, ...judgment.requirementRefs, ...judgment.diffRefs, ...judgment.repairRefs, ...judgment.testRefs]),
      });
      if (["notMet", "notVerifiable"].includes(judgment.status)) {
        builder.add({
          id: `acceptance.risk.requirement.${judgment.requirementId}`,
          kind: "remainingRisk",
          requirementId: judgment.requirementId,
          judgmentStatus: judgment.status,
          riskId: `requirement:${judgment.requirementId}`,
          risk: true,
          markdown: this.#renderRequirementRisk(judgment, requirement, t),
          sourceText: sourceText([requirement.desc, ...judgment.missingEvidence]),
        });
      }
    }
    builder.add({ id: "acceptance.mechanical-heading", kind: "mechanicalBlockersHeading", markdown: `## ${t.message("mechanicalBlockers")}\n\n` });
    if (review.mechanicalBlockers.length === 0) builder.add({ id: "acceptance.mechanical.empty", kind: "emptyMechanicalBlockers", markdown: `- ${t.message("noItems")}\n\n`, sourceText: "" });
    for (const rawBlocker of review.mechanicalBlockers) {
      const blocker = new MechanicalBlocker(rawBlocker);
      builder.add({
        id: `acceptance.mechanical.${blocker.blockerId}`,
        kind: "mechanicalBlocker",
        blockerId: blocker.blockerId,
        markdown: this.#renderMechanicalBlocker(blocker, t),
        sourceText: sourceText([blocker.blockerId, blocker.kind, blocker.summary, blocker.detail]),
        risk: true,
      });
      builder.add({
        id: `acceptance.risk.mechanical.${blocker.blockerId}`,
        kind: "remainingRisk",
        riskId: `mechanical:${blocker.blockerId}`,
        risk: true,
        markdown: this.#renderBlockerRisk(blocker.summary, blocker.blockerId, t),
        sourceText: sourceText([blocker.blockerId, blocker.summary, blocker.detail]),
      });
    }
    builder.add({ id: "acceptance.hard-heading", kind: "hardBlockersHeading", markdown: `## ${t.message("hardBlockers")}\n\n` });
    if (review.hardBlockers.length === 0) builder.add({ id: "acceptance.hard.empty", kind: "emptyHardBlockers", markdown: `- ${t.message("noItems")}\n\n`, sourceText: "" });
    review.hardBlockers.forEach((blocker) => {
      const record = new ArtifactViewDeferredFinding(blocker);
      if (!["still_open", "blocking"].includes(record.finalDisposition)) {
        throw new Error(`acceptance hard blocker must remain unresolved: ${record.findingId}`);
      }
      const reference = this.#resolvedFindingReference(record, referenceByFindingId);
      const detail = new ArtifactViewFindingDetail(reference.finding);
      builder.add({
        id: `acceptance.hard.${record.findingId}`,
        kind: "hardBlocker",
        blockerId: record.findingId,
        findingId: record.findingId,
        markdown: this.#renderHardBlocker(record, reference.flowFinding, detail, t),
        sourceText: sourceText([reference.flowFinding.rationale, reference.flowFinding.disposition, reference.flowFinding.finalDisposition, detail.sourceText()]),
        risk: true,
      });
    });
    builder.add({ id: "acceptance.deferred-heading", kind: "deferredFindingsHeading", markdown: `## ${t.message("deferredFindings")}\n\n` });
    if (review.deferredFindings.length === 0) builder.add({ id: "acceptance.deferred.empty", kind: "emptyDeferredFindings", markdown: `- ${t.message("noItems")}\n\n`, sourceText: "" });
    for (const deferred of review.deferredFindings) {
      const record = new ArtifactViewDeferredFinding(deferred);
      const reference = this.#resolvedFindingReference(record, referenceByFindingId);
      const detail = new ArtifactViewFindingDetail(reference.finding);
      builder.add({
        id: `acceptance.deferred.${record.findingId}`,
        kind: "deferredFinding",
        findingId: record.findingId,
        markdown: this.#renderDeferredFinding(record, reference.flowFinding, detail, t),
        sourceText: sourceText([reference.flowFinding.rationale, reference.flowFinding.disposition, reference.flowFinding.finalDisposition, detail.sourceText()]),
        risk: ["still_open", "blocking"].includes(record.finalDisposition),
      });
      if (["still_open", "blocking"].includes(record.finalDisposition)) {
        builder.add({
          id: `acceptance.risk.deferred.${record.findingId}`,
          kind: "remainingRisk",
          riskId: `deferred:${record.findingId}`,
          findingId: record.findingId,
          risk: true,
          markdown: this.#renderFindingRisk(record, detail, t),
          sourceText: detail.sourceText(),
        });
      }
    }
  }

  #renderDecision(decision, t) {
    const lines = [`## ${t.message("decision")}\n`];
    if (decision === null) lines.push(`- ${t.message("undecided")}\n`);
    else {
      const choice = decision.choice === "accept_risk_and_continue" ? t.message("acceptRisk") : t.message("abort");
      lines.push(`- **${t.message("decision")}**: ${choice}\n`);
      lines.push(`- **${t.message("decidedAt")}**: ${decision.decidedAt}\n`);
    }
    lines.push("\n");
    return lines.join("");
  }

  #renderJudgment(judgment, requirement, t) {
    const lines = [
      `### ${t.message("judgment")} ${judgment.requirementId}: ${statusLabel(t, judgment.status)}\n`,
      `**${t.message("requirement")}**: ${requirement.desc}\n\n`,
      `#### ${t.message("evidenceReferences")}\n`,
    ];
    for (const ref of [...judgment.requestRefs, ...judgment.requirementRefs, ...judgment.diffRefs, ...judgment.repairRefs, ...judgment.testRefs]) {
      lines.push(`- ${ref}\n`);
    }
    if (judgment.missingEvidence.length > 0) {
      lines.push(`\n#### ${t.message("missingEvidence")}\n`);
      lines.push(judgment.missingEvidence.map((entry) => `- ${entry}\n`).join(""));
    }
    lines.push("\n");
    return lines.join("");
  }

  #renderRequirementRisk(judgment, requirement, t) {
    const details = judgment.missingEvidence.length > 0 ? judgment.missingEvidence.map((entry) => `- ${entry}\n`).join("") : `- ${requirement.desc}\n`;
    return `### ${t.message("remainingRisk")}: ${requirement.id}\n${t.message("riskFromRequirement")}\n\n${details}\n`;
  }

  #renderMechanicalBlocker(blocker, t) {
    const lines = [
      `### ${t.message("mechanicalBlockers")} ${blocker.blockerId}\n`,
      labeledLine(t.message("kind"), blocker.kind, t.message("noItems")),
      labeledLine(t.message("summary"), blocker.summary, t.message("noItems")),
    ];
    if (rawText(blocker.detail)) lines.push(labeledLine(t.message("detail"), blocker.detail, t.message("noItems")));
    lines.push("\n");
    return lines.join("");
  }

  #renderBlockerRisk(detail, id, t) {
    return `### ${t.message("remainingRisk")}: ${id}\n${t.message("riskFromBlocker")}\n\n- ${detail}\n\n`;
  }

  #resolvedFindingReference(record, referenceByFindingId) {
    return record.assertReference(referenceByFindingId.get(record.findingId) ?? null);
  }

  #renderHardBlocker(record, flowFinding, detail, t) {
    return this.#renderResolvedFinding({
      record,
      flowFinding,
      detail,
      heading: t.message("hardBlocker"),
      localizer: t,
    });
  }

  #renderDeferredFinding(record, flowFinding, detail, t) {
    return this.#renderResolvedFinding({
      record,
      flowFinding,
      detail,
      heading: t.message("deferredFinding"),
      localizer: t,
    });
  }

  #renderResolvedFinding({ record, flowFinding, detail, heading, localizer }) {
    const lines = [
      `### ${heading} ${record.findingId}\n`,
      labeledLine(localizer.message("finalDisposition"), record.finalDisposition, localizer.message("noItems")),
      labeledLine(localizer.message("disposition"), flowFinding.disposition, localizer.message("noItems")),
      labeledLine(localizer.message("rationale"), flowFinding.rationale, localizer.message("noItems")),
      labeledLine(localizer.message("sourceStep"), record.sourceStep, localizer.message("noItems")),
      labeledLine(localizer.message("source"), `${record.sourceArtifact}#${record.sourceFindingId}`, localizer.message("noItems")),
      `#### ${localizer.message("originalFinding")}\n`,
      detail.toMarkdown(localizer),
      "\n",
    ];
    return lines.join("");
  }

  #renderFindingRisk(record, detail, t) {
    return `### ${t.message("remainingRisk")}: ${record.findingId}\n${t.message("riskFromFinding")}\n\n- ${detail.riskSummary(record.findingId)}\n\n`;
  }
}
