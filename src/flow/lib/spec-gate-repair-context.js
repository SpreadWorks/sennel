import { createHash } from "node:crypto";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  AtomicPromptElement, RangedTextPromptElement, PromptRequestEnvelope,
  PromptInputBuilder, PromptBatchPlan, PromptRequestLimit,
  PromptBatchGroup, GroupedPromptBatchTopology,
} from "../../lib/prompt-batching.js";
import { FlowFindingSourceIdentity } from "./flow-finding-source.js";
import { SpecRepairTarget, specRepairTargetEntries } from "./spec-repair-operations.js";
import { SpecGateDocumentTarget } from "./spec-gate-targets.js";
import { SpecGateRepairSource } from "./spec-gate-repair-values.js";

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function identity(value) { return value instanceof FlowFindingSourceIdentity ? value : new FlowFindingSourceIdentity(value); }
function targetKey(value) {
  const target = value instanceof SpecRepairTarget ? value : SpecRepairTarget.fromJSON(value, "repair context target");
  return JSON.stringify(target.toJSON());
}

/** A canonical field, with stable entity identity rather than an array ordinal. */
export class SpecGateRepairRange {
  constructor({ id, path, value, entity = null, target = null, digest = hash(value), collectionAnchor = false, exists = true }) {
    this.id = id;
    this.path = path;
    this.value = freeze(structuredClone(value));
    this.entity = entity;
    this.target = target;
    this.digest = digest;
    this.collectionAnchor = collectionAnchor;
    this.exists = exists;
    Object.freeze(this);
  }
  descriptor() {
    return { id: this.id, path: this.path, entity: this.entity, digest: this.digest,
      target: this.target?.toJSON() ?? null, collectionAnchor: this.collectionAnchor, exists: this.exists };
  }
  toJSON({ writable = false } = {}) { return { ...this.descriptor(), writable, value: this.value }; }
}

export class SpecGateRepairFinding {
  constructor(value, rangeIds = []) {
    this.identity = identity(value.identity);
    if (typeof value.requirementRef !== "string" || !value.requirementRef
      || typeof value.observed !== "string" || !value.observed) {
      throw new TypeError("Gate repair finding requires its rule and complete reason");
    }
    this.requirementRef = value.requirementRef;
    this.observed = value.observed;
    this.where = freeze(structuredClone(value.where ?? null));
    this.targets = freeze(structuredClone(value.targets ?? []));
    this.allowedTargets = freeze(structuredClone(value.allowedTargets ?? []));
    this.specRevision = value.specRevision ?? null;
    this.rangeIds = Object.freeze([...rangeIds].sort());
    Object.freeze(this);
  }
  toJSON() {
    return { identity: this.identity.toJSON(), requirementRef: this.requirementRef,
      observed: this.observed, where: this.where, targets: this.targets,
      allowedTargets: this.allowedTargets, ...(this.specRevision === null ? {} : { specRevision: this.specRevision }),
      rangeIds: this.rangeIds };
  }
}

/** Connected findings form one indivisible proposal, even across several fields. */
export class SpecGateRepairUnit {
  constructor(findings) {
    this.findings = Object.freeze([...findings].sort((a, b) => a.identity.toString().localeCompare(b.identity.toString())));
    this.rangeIds = Object.freeze([...new Set(findings.flatMap((item) => item.rangeIds))].sort());
    this.id = `repair-unit:${hash(this.findings.map((item) => item.identity.toJSON()))}`;
    Object.freeze(this);
  }
  toJSON() { return { id: this.id, rangeIds: this.rangeIds, findings: this.findings.map((item) => item.toJSON()) }; }
}

export class SpecGateRepairSelection {
  constructor({ baseRevision, unit, ranges, guardrails, acknowledgedRationale }) {
    this.baseRevision = baseRevision;
    this.unit = unit;
    this.ranges = freeze(ranges);
    this.guardrails = freeze(structuredClone(guardrails));
    this.acknowledgedRationale = acknowledgedRationale;
    Object.freeze(this);
  }
  toJSON() {
    return { baseRevision: this.baseRevision, unit: this.unit.toJSON(), ranges: this.ranges,
      guardrails: this.guardrails, acknowledgedRationale: this.acknowledgedRationale };
  }
}

class SpecGateRepairEnvelope extends PromptRequestEnvelope {
  constructor({ baseRevision, mode, fixed = null }) { super(); this.baseRevision = baseRevision; this.mode = mode; this.fixed = fixed; }
  build(elements) {
    return new PromptBuilder()
      .setRole(this.mode === "locate" ? "Locate Spec Gate findings in the canonical structural index."
        : this.mode === "evidence" ? "Read the supplied parts of one indivisible Spec Gate repair unit."
          : "Propose bounded operations for the supplied Spec Gate repair units.")
      .setRules([
        "This is the Spec stage. Evaluate the planned verification method and acceptance conditions. Executed evidence belongs to later stages.",
        "The source is deliberately selected, not the full document. Never infer absence from an omitted range. Request additional range IDs bound to baseRevision when needed.",
        "Keep each complete finding identity and source citation. An exception needs the canonical rule's exception clause, not acknowledgment alone.",
        "Read-only ranges are context, not authority to change them. Only the explicit allowedTargets and operationKinds grant mutation authority.",
        "Never rewrite the full Spec. All proposals share the given baseRevision and original value digests. Do not apply a proposal to another proposal's output.",
        this.mode === "locate" ? "Return locations with exact finding identity and existing rangeIds only. Do not fabricate a position or declare a free-text location resolved by approximation. The repeated location element is the finding; other elements are one part of the structural index. Return that exact finding once, with only rangeIds present in this part. Return an empty rangeIds array if this part contains no matching location; the parent combines every part before declaring it unresolved."
          : this.mode === "evidence" ? "Collect support, contradictions, unresolved questions and exact range citations; do not propose independent partial changes. The final proposal must cover the entire unit."
            : "Return one atomic group per unit, preserving all findingIdentities. Resolve facts from supplied Issue, request, prior Draft answers, rules and source evidence before proposing any return to Draft. Only a genuinely missing user choice may produce spec-gate-repair-draft-return with unitId, decision, evidence and unresolvedBecause. Missing context, tooling failures or inability to locate text are not user choices. Never ask the user directly.",
      ].join("\n"))
      .addUserPrompt("## Canonical revision", this.baseRevision)
      .addUserPrompt("## Required context", JSON.stringify(this.fixed))
      .addUserPrompt("## Selected input", JSON.stringify(elements.map((entry) => ({
        id: entry.id, originId: entry.originId, start: entry.start, end: entry.end, content: entry.toPromptText(),
      }))))
      .build();
  }
}

function planFor(elements, envelope, limit) {
  const builder = new PromptInputBuilder({ envelope, limit });
  elements.forEach((element) => builder.add(element));
  return PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
}

/** Pure canonical context selection. Persistence and call admission belong to the Service. */
export class SpecGateRepairContext {
  static evidenceDigestFor({ sources, guardrails }) {
    if (!Array.isArray(sources) || sources.some((source) => !(source instanceof SpecGateRepairSource))) {
      throw new TypeError("Repair evidence requires typed read-only sources");
    }
    if (!Array.isArray(guardrails)) throw new TypeError("Repair evidence requires canonical guardrails");
    return createHash("sha256").update(JSON.stringify({
      sources: sources.map((source) => [source.id, source.digest]), guardrails,
    }, (_, value) => value instanceof RegExp
      ? { source: value.source, flags: value.flags } : value)).digest("hex");
  }
  #ranges = new Map();
  #ordinalRanges = new Map();
  #explicitAliases = new Map();
  #targets = new Map();
  #findings;
  #spec;
  #guardrails;
  #rationale;
  #sources;

  constructor({ spec, baseRevision, findings, guardrails, acknowledgedRationale = "", sources = [] }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(baseRevision)) throw new TypeError("Repair context requires a canonical base revision");
    if (!Array.isArray(findings) || !findings.length || !Array.isArray(guardrails)) throw new TypeError("Repair context requires canonical findings and rules");
    this.baseRevision = baseRevision;
    this.#spec = freeze(structuredClone(spec));
    this.#guardrails = freeze(structuredClone(guardrails));
    this.#rationale = acknowledgedRationale;
    const evidenceDigest = SpecGateRepairContext.evidenceDigestFor({ sources, guardrails: this.#guardrails });
    this.#sources = Object.freeze([...sources]);
    this.evidenceDigest = evidenceDigest;
    const editable = specRepairTargetEntries(spec);
    const byPath = new Map();
    for (const entry of editable) {
      const target = entry.target;
      const json = target.toJSON();
      const path = json.entity === "spec" ? json.field
        : json.entity ? `${json.entity}s[${json.id}].${json.field}`
          : json.position == null ? json.collection : `${json.collection}[${json.position}]`;
      byPath.set(path, entry);
      if (entry.exists && ["requirement", "task"].includes(json.entity)) {
        const alias = `${json.entity}s.${json.id}.${json.field}`;
        this.#explicitAliases.set(alias, this.#explicitAliases.has(alias) ? null : path);
      }
    }
    const add = (path, value, entity = null, collectionAnchor = false, ordinalPath = path) => {
      const entry = byPath.get(path);
      const range = new SpecGateRepairRange({ id: path, path, value, entity,
        target: entry?.target ?? null, collectionAnchor, ...(entry ? { digest: entry.digest, exists: entry.exists } : {}) });
      this.#ranges.set(range.id, range);
      this.#ordinalRanges.set(ordinalPath, range.id);
      if (range.target) this.#targets.set(targetKey(range.target), range.id);
    };
    const walk = (value, path = "", entity = null, ordinalPath = path) => {
      if (Array.isArray(value)) {
        // Collections themselves are available for explicit additions, not implicit replacements.
        if (byPath.has(path)) add(path, { itemCount: value.length, contentOmitted: true }, entity, true, ordinalPath);
        value.forEach((item, index) => {
          const identified = ["requirements", "tasks"].includes(path) && typeof item?.id === "string";
          walk(item, `${path}[${identified ? item.id : index}]`, identified ? `${path}:${item.id}` : entity,
            `${ordinalPath}[${index}]`);
        });
      } else if (value && typeof value === "object") {
        if (byPath.has(path)) add(path, value, entity, false, ordinalPath);
        else Object.entries(value).forEach(([key, child]) => walk(child, path ? `${path}.${key}` : key, entity,
          ordinalPath ? `${ordinalPath}.${key}` : key));
      } else add(path, value, entity, false, ordinalPath);
    };
    walk(this.#spec);
    for (const [path, entry] of byPath) {
      if (!this.#ranges.has(path) && entry.exists === false) {
        const target = entry.target.toJSON();
        add(path, null, target.entity && target.entity !== "spec" ? `${target.entity}s:${target.id}` : null);
      }
    }
    this.#findings = Object.freeze(findings.map((finding) => {
      if (finding.specRevision != null && finding.specRevision !== baseRevision) {
        throw new Error("Stale Spec Gate finding target revision");
      }
      const ids = [...new Set([...(finding.rangeIds ?? this.#initialRanges(finding)),
        ...(finding.allowedTargets ?? []).map((permission) => this.#targetRange(permission.target)),
      ])];
      this.#assertRanges(ids);
      return new SpecGateRepairFinding(finding, ids);
    }));
    const identities = this.#findings.map((finding) => finding.identity.toString());
    if (new Set(identities).size !== identities.length) throw new Error("Duplicate canonical Gate finding identity");
    for (const finding of this.#findings) {
      if (!guardrails.some((rule) => rule.id === finding.requirementRef)) throw new Error("Canonical guardrail body is missing for a repair finding");
    }
    for (const source of this.#sources) {
      if (this.#ranges.has(source.id)) throw new Error("Duplicate repair evidence source");
      this.#ranges.set(source.id, new SpecGateRepairRange({ id: source.id, path: source.id,
        value: source.toJSON(), digest: source.digest }));
    }
  }

  #initialRanges(finding) {
    if (finding.targets?.length) return [...new Set(finding.targets.flatMap((target) =>
      Object.hasOwn(target, "document")
        ? (new SpecGateDocumentTarget(target), [...this.#ranges.keys()])
        : [this.#targetRange(target)]))];
    const locator = finding.where?.locator;
    if (typeof locator !== "string") return [];
    const path = locator.startsWith("$.") ? locator.slice(2) : locator;
    const id = this.#ordinalRanges.get(path) ?? this.#explicitAliases.get(path)
      ?? (this.#ranges.has(path) ? path : null);
    return id === null ? [] : [id];
  }
  #targetRange(target) {
    const id = this.#targets.get(targetKey(target));
    if (!id) throw new Error("Repair target does not exist in the canonical Spec");
    return id;
  }
  #assertRanges(ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !this.#ranges.has(id))) {
      throw new Error("Repair context has a missing, duplicated or foreign canonical range");
    }
  }
  tableOfContents() { return [...this.#ranges.values()].map((range) => range.descriptor()); }
  unresolvedFindings() { return this.#findings.filter((finding) => finding.rangeIds.length === 0); }
  resolveLocations({ baseRevision, locations }) {
    if (baseRevision !== this.baseRevision) throw new Error("Stale repair location response");
    const unresolved = new Map(this.unresolvedFindings().map((finding) => [finding.identity.toString(), finding]));
    const resolved = new Map();
    for (const location of locations) {
      const key = identity(location.identity).toString();
      if (!unresolved.has(key) || resolved.has(key)) throw new Error("Foreign or duplicate repair location identity");
      this.#assertRanges(location.rangeIds);
      if (location.rangeIds.some((id) => id.startsWith("evidence:"))) throw new Error("Read-only evidence is not a Spec finding location");
      resolved.set(key, location.rangeIds);
    }
    if (resolved.size !== unresolved.size) throw new Error("Location response omitted a Gate finding");
    return new SpecGateRepairContext({ spec: this.#spec, baseRevision, guardrails: this.#guardrails,
      sources: this.#sources,
      acknowledgedRationale: this.#rationale, findings: this.#findings.map((finding) => ({
        ...finding.toJSON(), rangeIds: resolved.get(finding.identity.toString()) ?? finding.rangeIds,
      })) });
  }
  units() {
    if (this.unresolvedFindings().length) throw new Error("Spec Gate repair locations remain unresolved");
    const groups = [];
    for (const finding of this.#findings) {
      const overlaps = (left, right) => left === right
        || (this.#ranges.get(left).collectionAnchor && right.startsWith(`${left}[`))
        || (this.#ranges.get(right).collectionAnchor && left.startsWith(`${right}[`));
      const connected = groups.filter((group) => group.some((other) => other.rangeIds.some((id) => finding.rangeIds.some((otherId) => overlaps(id, otherId)))));
      const merged = [finding, ...connected.flat()];
      connected.forEach((group) => groups.splice(groups.indexOf(group), 1));
      groups.push(merged);
    }
    return groups.map((group) => new SpecGateRepairUnit(group)).sort((a, b) => a.id.localeCompare(b.id));
  }
  select(unitId, { additionalRangeIds = [] } = {}) {
    this.#assertRanges(additionalRangeIds);
    const unit = this.units().find((entry) => entry.id === unitId);
    if (!unit) throw new Error("Unknown Spec Gate repair unit");
    const selected = new Set([...unit.rangeIds, ...additionalRangeIds, ...this.#sources.map((source) => source.id)]);
    const entities = new Set([...selected].map((id) => this.#ranges.get(id).entity).filter(Boolean));
    let previousSize;
    do {
      previousSize = entities.size;
      for (const requirement of this.#spec.requirements) {
        if (entities.has(`requirements:${requirement.id}`)
          || requirement.task_ids.some((id) => entities.has(`tasks:${id}`))) {
          entities.add(`requirements:${requirement.id}`);
          requirement.task_ids.forEach((id) => entities.add(`tasks:${id}`));
        }
      }
    } while (entities.size !== previousSize);
    for (const range of this.#ranges.values()) {
      if (entities.has(range.entity) || range.path.startsWith("overview.decisions[")) selected.add(range.id);
    }
    const permissions = new Set(unit.findings.flatMap((finding) => finding.allowedTargets.map((permission) => targetKey(permission.target))));
    return new SpecGateRepairSelection({ baseRevision: this.baseRevision, unit,
      ranges: [...selected].sort().map((id) => {
        const range = this.#ranges.get(id);
        return range.toJSON({ writable: unit.rangeIds.includes(id) && range.target !== null && permissions.has(targetKey(range.target)) });
      }),
      guardrails: this.#guardrails.filter((rule) => unit.findings.some((finding) => finding.requirementRef === rule.id)),
      acknowledgedRationale: this.#rationale });
  }
  plan({ limit = new PromptRequestLimit(), additionalRanges = {}, unitIds = null } = {}) {
    const units = this.units();
    if (unitIds !== null && (!Array.isArray(unitIds) || new Set(unitIds).size !== unitIds.length
      || unitIds.some((id) => !units.some((unit) => unit.id === id)))) throw new Error("Unknown or duplicate repair unit");
    return planFor(units.filter((unit) => unitIds === null || unitIds.includes(unit.id)).map((unit, sequence) => new AtomicPromptElement({
      id: unit.id, sourceRevision: this.baseRevision, sequence,
      text: JSON.stringify(this.select(unit.id, { additionalRangeIds: additionalRanges[unit.id] ?? [] }).toJSON()),
    })), new SpecGateRepairEnvelope({ baseRevision: this.baseRevision, mode: "repair" }), limit);
  }
  locationPlan({ limit = new PromptRequestLimit() } = {}) {
    const envelope = new SpecGateRepairEnvelope({ baseRevision: this.baseRevision, mode: "locate" });
    const builder = new PromptInputBuilder({ envelope, limit });
    let sequence = 0;
    const groups = this.unresolvedFindings().map((finding) => {
      const id = `location:${hash(finding.identity.toJSON())}`;
      const context = new AtomicPromptElement({ id, sourceRevision: this.baseRevision,
        sequence: sequence++, text: JSON.stringify(finding.toJSON()) });
      builder.add(context);
      const payloadElements = this.tableOfContents().filter((range) => !range.id.startsWith("evidence:")).map((range) => {
        const element = new AtomicPromptElement({ id: `${id}:${range.id}`, sourceRevision: this.baseRevision,
          sequence: sequence++, text: JSON.stringify(range) });
        builder.add(element);
        return element;
      });
      return new PromptBatchGroup({ id, contextElements: [context], payloadElements });
    });
    return PromptBatchPlan.create({ collection: builder.build(), envelope, limit,
      topology: new GroupedPromptBatchTopology({ groups }) });
  }
  resolveLocationBatches({ plan, responses }) {
    if (!(plan instanceof PromptBatchPlan) || !Array.isArray(responses)
      || responses.length !== plan.batches.length) throw new Error("Location responses must cover every planned batch");
    const expected = new Map(plan.batches.map((batch) => [batch.digest, batch]));
    const merged = new Map();
    for (const response of responses) {
      const batch = expected.get(response.batchDigest);
      if (!batch || response.baseRevision !== this.baseRevision) throw new Error("Stale, duplicate or foreign location batch");
      expected.delete(response.batchDigest);
      const finding = JSON.parse(batch.contextElements[0].toPromptText());
      const allowed = new Set(batch.payloadElements.map((entry) => JSON.parse(entry.toPromptText()).id));
      if (!Array.isArray(response.locations) || response.locations.length !== 1
        || identity(response.locations[0].identity).toString() !== identity(finding.identity).toString()) {
        throw new Error("Location batch omitted or changed its finding identity");
      }
      const location = response.locations[0];
      this.#assertRanges(location.rangeIds);
      if (location.rangeIds.some((id) => !allowed.has(id))) throw new Error("Location batch cited an unsearched range");
      const key = identity(finding.identity).toString();
      const accumulated = merged.get(key) ?? { identity: finding.identity, rangeIds: new Set() };
      location.rangeIds.forEach((id) => accumulated.rangeIds.add(id));
      merged.set(key, accumulated);
    }
    return this.resolveLocations({ baseRevision: this.baseRevision,
      locations: [...merged.values()].map((entry) => ({ identity: entry.identity, rangeIds: [...entry.rangeIds] })) });
  }
  evidencePlan(unitId, { limit = new PromptRequestLimit(), additionalRangeIds = [] } = {}) {
    const selection = this.select(unitId, { additionalRangeIds }).toJSON();
    const { ranges, ...fixed } = selection;
    return planFor(ranges.map((range, sequence) => new RangedTextPromptElement({
      id: range.id, sourceRevision: this.baseRevision, sequence, text: JSON.stringify(range),
    })), new SpecGateRepairEnvelope({ baseRevision: this.baseRevision, mode: "evidence", fixed }), limit);
  }
}
