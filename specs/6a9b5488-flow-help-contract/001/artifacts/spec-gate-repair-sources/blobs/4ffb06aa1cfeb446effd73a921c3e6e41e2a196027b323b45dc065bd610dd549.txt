/**
 * src/lib/skill-rules.js
 *
 * Loader and expander for skill-rules.json (the SSOT for Issue #311 persistent skill rules).
 *
 * Public surface:
 *   loadRules() / loadRulesFromFile(path) / loadRulesFromString(json)
 *     -> validated rule list (throws on schema violation)
 *   filterRules(rules, { phase, state })
 *     -> filtered subset (phase any-match, state all-required, state=[] always-on)
 *   renderRuleBlock(rules) -> string | "" (the markdown block per spec R37, with trailing newline omitted)
 *   expandSkillRulesDirectives(content) -> string (in-place expansion of base.skills.rule data directives)
 *   VALID_SKILL_RULE_PHASES, VALID_SKILL_RULE_STATES, DRIFT_PRONE_RULE_IDS
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  collectFlowLeafIds,
  collectTaskLeafIds,
} from "../flow/definition.js";
import { parseDirectives } from "../docs/lib/directive-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Canonical packaged location of rules.json. */
export const RULES_JSON_PATH = path.resolve(__dirname, "..", "skills", "rules.json");

/** Canonical scope-aware leaf id strings (24 entries). */
export const VALID_SKILL_RULE_PHASES = Object.freeze([
  ...collectFlowLeafIds().map((id) => `flow.${id}`),
  ...collectTaskLeafIds().map((id) => `task.${id}`),
]);

const VALID_PHASE_SET = new Set(VALID_SKILL_RULE_PHASES);

export const VALID_SKILL_RULE_STATES = Object.freeze(["worktreeActive", "autoApproveOn"]);
const VALID_STATE_SET = new Set(VALID_SKILL_RULE_STATES);

/** Curated set of drift-prone rule ids whose body must contain ### MUST + ### Why + ### How to apply. */
export const DRIFT_PRONE_RULE_IDS = Object.freeze([
  "no-premature-conclusion",
  "no-auto-mode-override-skill",
  "wait-for-instruction-skill",
]);

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const ALLOWED_FIELDS = new Set(["id", "phase", "state", "body"]);

function fail(message) {
  throw new Error(`rules.json: ${message}`);
}

function validateRule(rule, seenIds) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    fail("rule entry must be an object");
  }
  for (const key of Object.keys(rule)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`unknown field "${key}" in rule entry`);
  }
  if (typeof rule.id !== "string" || !rule.id) fail("rule entry missing required field id");
  if (!KEBAB_RE.test(rule.id)) fail(`malformed kebab-case id "${rule.id}"`);
  if (seenIds.has(rule.id)) fail(`duplicate id "${rule.id}"`);
  seenIds.add(rule.id);
  if (!Array.isArray(rule.phase) || rule.phase.length === 0) {
    fail(`rule "${rule.id}" missing required non-empty phase array`);
  }
  for (const p of rule.phase) {
    if (typeof p !== "string" || !VALID_PHASE_SET.has(p)) {
      fail(`unknown phase "${p}" in rule "${rule.id}"`);
    }
  }
  if (rule.state !== undefined) {
    if (!Array.isArray(rule.state)) fail(`rule "${rule.id}" state must be an array`);
    for (const s of rule.state) {
      if (typeof s !== "string" || !VALID_STATE_SET.has(s)) {
        fail(`unknown state "${s}" in rule "${rule.id}"`);
      }
    }
  }
  if (typeof rule.body !== "string" || !rule.body) fail(`rule "${rule.id}" missing required body`);
  if (rule.body !== rule.body.replace(/^\n+/, "").replace(/\n+$/, "")) {
    fail(`rule "${rule.id}" body must not have leading or trailing blank lines`);
  }
  if (DRIFT_PRONE_RULE_IDS.includes(rule.id)) {
    if (!/^### MUST/m.test(rule.body)) fail(`drift-prone rule "${rule.id}" missing ### MUST heading`);
    if (!/^### Why/m.test(rule.body)) fail(`drift-prone rule "${rule.id}" missing ### Why heading`);
    if (!/^### How to apply/m.test(rule.body)) fail(`drift-prone rule "${rule.id}" missing ### How to apply heading`);
  }
}

function validateAndNormalize(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
    fail("file must be an object with a `rules` array");
  }
  const allowedTopLevel = new Set(["rules"]);
  for (const k of Object.keys(parsed)) {
    if (!allowedTopLevel.has(k)) fail(`unknown top-level field "${k}"`);
  }
  const seen = new Set();
  for (const r of parsed.rules) validateRule(r, seen);
  return parsed.rules.map((r) => ({
    id: r.id,
    phase: [...r.phase],
    state: r.state ? [...r.state] : [],
    body: r.body,
  }));
}

/** Load rules from the bundled rules.json (resolves relative to package). */
export function loadRules() {
  return loadRulesFromFile(RULES_JSON_PATH);
}

export function loadRulesFromFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return loadRulesFromString(content);
}

export function loadRulesFromString(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    fail(`invalid JSON: ${err.message}`);
  }
  return validateAndNormalize(parsed);
}

/**
 * Filter rules by current phase + state.
 * @param {Array} rules - already-validated rules
 * @param {{phase: string, state: string[]}} ctx
 *   phase: scope-aware leaf id (e.g. "flow.draft")
 *   state: array of state names that are currently active
 * @returns matched rules in author order
 */
export function filterRules(rules, { phase, state }) {
  const stateSet = new Set(state || []);
  const out = [];
  for (const r of rules) {
    if (!r.phase.includes(phase)) continue;
    if (r.state && r.state.length > 0) {
      const allMet = r.state.every((s) => stateSet.has(s));
      if (!allMet) continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * Render the markdown rule block for next-action injection.
 * Returns "" when rules is empty (caller responsible for prepending nothing).
 */
export function renderRuleBlock(rules) {
  if (!rules || rules.length === 0) return "";
  const parts = ["## Persistent Rules", ""];
  for (const r of rules) {
    parts.push(`<!-- rule: ${r.id} -->`);
    parts.push(r.body.replace(/\n+$/, ""));
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Synchronously expand all `<!-- {{data("base.skills.rule", {id: "..."})}} -->` ... `<!-- {{/data}} -->`
 * blocks in `content`. Throws on unknown id (UnknownSkillRuleError).
 *
 * Other data directives (non-skills.rule) are left untouched.
 */
export function expandSkillRulesDirectives(content, rules) {
  const ruleIndex = new Map(rules.map((r) => [r.id, r]));
  const directives = parseDirectives(content);
  const skillDirectives = directives.filter(
    (d) => d.type === "data" && d.source === "skills" && d.method === "rule",
  );
  if (skillDirectives.length === 0) return content;
  const lines = content.split("\n");
  // Walk directives in reverse so line numbers remain valid as we rewrite.
  const sorted = [...skillDirectives].sort((a, b) => b.line - a.line);
  for (const d of sorted) {
    const id = d.params?.id;
    if (typeof id !== "string" || !id) {
      throw new Error(`unknown skill rule id "" referenced at line ${d.line + 1}`);
    }
    const rule = ruleIndex.get(id);
    if (!rule) {
      throw new Error(`unknown skill rule id "${id}" referenced at line ${d.line + 1}`);
    }
    if (d.inline) {
      // Inline form: rebuild the line keeping the markers + body
      const open = `<!-- {{data("base.skills.rule", {id: "${id}"})}} -->`;
      const close = `<!-- {{/data}} -->`;
      lines[d.line] = `${open}\n${rule.body.replace(/\n+$/, "")}\n${close}`;
      continue;
    }
    // Block form: replace lines from d.line..d.endLine with marker / body / marker
    const replacement = [
      `<!-- {{data("base.skills.rule", {id: "${id}"})}} -->`,
      rule.body.replace(/\n+$/, ""),
      `<!-- {{/data}} -->`,
    ];
    lines.splice(d.line, d.endLine - d.line + 1, ...replacement);
  }
  return lines.join("\n");
}
