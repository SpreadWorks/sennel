/**
 * src/lib/agent-defaults.js
 *
 * Built-in agent providers and profiles resolved at runtime. The content is
 * generic: model tiers plus sennel command ids only — no project/environment-
 * specific values (no hostnames, ports, etc.), so it is safe to ship in the
 * package per the src/ project-info rule.
 *
 * Single source of truth: callers do not import the raw constants. Runtime
 * resolvers call `defaultAgentProfiles()` and `defaultAgentProviders()` and
 * layer user config on top. Providers are derived from the profiles — only
 * providers actually referenced by the built-in profiles are exposed here.
 */

function codexProvider(model, effort) {
  return {
    command: "codex",
    args: [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-m",
      model,
      "-c",
      `model_reasoning_effort="${effort}"`,
      "{{PROMPT}}",
    ],
    jsonOutputFlag: "--json",
    jsonSchemaFlag: "--output-schema",
    jsonSchemaMode: "file",
  };
}

// Provider pool: only providers referenced by the default profiles below.
const PROVIDER_POOL = {
  "claude/sonnet": {
    command: "claude",
    args: ["-p", "{{PROMPT}}", "--model", "sonnet", "--output-format", "json"],
    systemPromptFlag: "--system-prompt",
    jsonOutputFlag: "--output-format json",
    jsonSchemaFlag: "--json-schema",
    jsonSchemaMode: "inline",
  },
  "claude/opus": {
    command: "claude",
    args: ["-p", "{{PROMPT}}", "--model", "opus", "--output-format", "json"],
    systemPromptFlag: "--system-prompt",
    jsonOutputFlag: "--output-format json",
    jsonSchemaFlag: "--json-schema",
    jsonSchemaMode: "inline",
  },
  "claude/haiku": {
    command: "claude",
    args: ["-p", "{{PROMPT}}", "--model", "haiku", "--output-format", "json"],
    systemPromptFlag: "--system-prompt",
    jsonOutputFlag: "--output-format json",
    jsonSchemaFlag: "--json-schema",
    jsonSchemaMode: "inline",
  },
  "codex/gpt-5.6-luna-low": codexProvider("gpt-5.6-luna", "low"),
  "codex/gpt-5.6-terra-low": codexProvider("gpt-5.6-terra", "low"),
  "codex/gpt-5.6-terra-medium": codexProvider("gpt-5.6-terra", "medium"),
  "codex/gpt-5.6-sol-medium": codexProvider("gpt-5.6-sol", "medium"),
  "codex/gpt-6-luna-low": codexProvider("gpt-6-luna", "low"),
  "codex/gpt-6-sol-low": codexProvider("gpt-6-sol", "low"),
  "codex/gpt-6-sol-medium": codexProvider("gpt-6-sol", "medium"),
  "codex/gpt-6-astra-medium": codexProvider("gpt-6-astra", "medium"),
};

const PROFILES = {
  "claude-main": {
    "docs.init": "claude/sonnet",
    "docs.enrich": "claude/sonnet",
    "docs.text": "claude/sonnet",
    "docs.forge": "claude/sonnet",
    "docs.readme": "claude/sonnet",
    "docs.agents": "claude/haiku",
    "docs.translate": "codex/gpt-5.6-terra-low",
    "flow.auto-check": "claude/sonnet",
    "flow.dispatch": "claude/sonnet",
    "flow.spec.gate": "claude/sonnet",
    "flow.spec.review.propose": "codex/gpt-5.6-sol-medium",
    "flow.draft.review.questions.propose": "codex/gpt-5.6-sol-medium",
    "flow.draft.review.coverage.propose": "codex/gpt-5.6-sol-medium",
    "flow.impl.review.propose": "codex/gpt-5.6-sol-medium",
    "flow.impl.review.final": "claude/opus",
    "flow.test.execute": "claude/sonnet",
    "flow.test.result-review": "claude/haiku",
    "flow.test.review": "codex/gpt-5.6-sol-medium",
    "flow.finalize.retro": "claude/haiku",
    "flow.context.search": "claude/haiku",
  },
  "codex-main": {
    "docs.init": "claude/sonnet",
    "docs.enrich": "claude/sonnet",
    "docs.text": "claude/sonnet",
    "docs.forge": "claude/sonnet",
    "docs.readme": "codex/gpt-5.6-luna-low",
    "docs.agents": "codex/gpt-5.6-luna-low",
    "docs.translate": "codex/gpt-5.6-terra-low",
    "flow.auto-check": "claude/sonnet",
    "flow.dispatch": "codex/gpt-5.6-terra-medium",
    "flow.spec.gate": "codex/gpt-5.6-terra-medium",
    "flow.spec.review.propose": "claude/opus",
    "flow.draft.review.questions.propose": "claude/opus",
    "flow.draft.review.coverage.propose": "claude/opus",
    "flow.impl.review.propose": "claude/opus",
    "flow.impl.review.final": "claude/opus",
    "flow.test.execute": "claude/sonnet",
    "flow.test.result-review": "codex/gpt-5.6-terra-medium",
    "flow.test.review": "claude/opus",
    "flow.finalize.retro": "codex/gpt-5.6-luna-low",
    "flow.context.search": "codex/gpt-5.6-luna-low",
  },
  "claude-only": {
    docs: "claude/sonnet",
    "docs.agents": "claude/haiku",
    "flow.auto-check": "claude/sonnet",
    "flow.dispatch": "claude/sonnet",
    "flow.spec.gate": "claude/sonnet",
    "flow.spec.review.propose": "claude/opus",
    "flow.draft.review.questions.propose": "claude/opus",
    "flow.draft.review.coverage.propose": "claude/opus",
    "flow.impl.review.propose": "claude/opus",
    "flow.impl.review.final": "claude/opus",
    "flow.test.execute": "claude/sonnet",
    "flow.test.result-review": "claude/haiku",
    "flow.test.review": "claude/opus",
    "flow.finalize.retro": "claude/haiku",
    "flow.context.search": "claude/haiku",
  },
  "codex-only": {
    "docs.init": "codex/gpt-6-sol-low",
    "docs.enrich": "codex/gpt-6-sol-low",
    "docs.text": "codex/gpt-6-sol-low",
    "docs.forge": "codex/gpt-6-sol-low",
    "docs.readme": "codex/gpt-6-luna-low",
    "docs.agents": "codex/gpt-6-luna-low",
    "docs.translate": "codex/gpt-6-sol-low",
    "flow.auto-check": "codex/gpt-6-sol-medium",
    "flow.dispatch": "codex/gpt-6-sol-medium",
    "flow.spec.gate": "codex/gpt-6-sol-medium",
    "flow.spec.review.propose": "codex/gpt-6-astra-medium",
    "flow.draft.review.questions.propose": "codex/gpt-6-astra-medium",
    "flow.draft.review.coverage.propose": "codex/gpt-6-astra-medium",
    "flow.impl.review.propose": "codex/gpt-6-astra-medium",
    "flow.impl.review.final": "codex/gpt-6-astra-medium",
    "flow.test.execute": "codex/gpt-6-sol-medium",
    "flow.test.result-review": "codex/gpt-6-sol-medium",
    "flow.test.review": "codex/gpt-6-astra-medium",
    "flow.finalize.retro": "codex/gpt-6-luna-low",
    "flow.context.search": "codex/gpt-6-luna-low",
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Default agent profiles (deep clone). */
export function defaultAgentProfiles() {
  return clone(PROFILES);
}

/** Providers referenced by the default profiles (deep clone). */
export function defaultAgentProviders() {
  const referenced = referencedProviderKeys(PROFILES);
  const out = {};
  for (const key of referenced) {
    if (!PROVIDER_POOL[key]) {
      throw new Error(`agent-defaults: default profile references unknown provider "${key}"`);
    }
    out[key] = clone(PROVIDER_POOL[key]);
  }
  return out;
}

function referencedProviderKeys(profiles) {
  const keys = new Set();
  for (const profile of Object.values(profiles)) {
    for (const providerKey of Object.values(profile)) keys.add(providerKey);
  }
  return keys;
}

/**
 * Add-only merge of built-in profiles and their referenced providers into an
 * agent config object. Existing user values always win. This is retained as a
 * direct utility for callers that explicitly request materialized defaults;
 * setup and normal upgrade do not call it.
 *   - existing profile names keep their slots; only missing slots are added.
 *   - existing provider entries are never overwritten.
 *   - only providers referenced by the resulting profiles (and known in the
 *     pool) are added.
 * `default` / `useProfile` are never touched.
 *
 * @param {object} agent - the `config.agent` object (mutated in place)
 * @returns {{changed: boolean, addedProfiles: string[], addedSlots: string[], addedProviders: string[]}}
 */
export function mergeAgentDefaults(agent) {
  if (!agent || typeof agent !== "object") {
    throw new Error("mergeAgentDefaults: agent must be an object");
  }
  if (!agent.profiles || typeof agent.profiles !== "object") agent.profiles = {};
  if (!agent.providers || typeof agent.providers !== "object") agent.providers = {};

  const addedProfiles = [];
  const addedSlots = [];
  const addedProviders = [];

  // 1) Profiles: add missing profiles whole; for existing ones, add missing slots only.
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (!(name in agent.profiles)) {
      agent.profiles[name] = clone(profile);
      addedProfiles.push(name);
      continue;
    }
    const target = agent.profiles[name];
    if (!target || typeof target !== "object") continue;
    for (const [commandId, providerKey] of Object.entries(profile)) {
      if (!(commandId in target)) {
        target[commandId] = providerKey;
        addedSlots.push(`${name}.${commandId}`);
      }
    }
  }

  // 2) Providers: add those referenced by the resulting profiles, known in the
  //    pool, and not already defined by the user.
  const referenced = referencedProviderKeys(agent.profiles);
  for (const key of referenced) {
    if (!(key in agent.providers) && PROVIDER_POOL[key]) {
      agent.providers[key] = clone(PROVIDER_POOL[key]);
      addedProviders.push(key);
    }
  }

  return {
    changed: addedProfiles.length > 0 || addedSlots.length > 0 || addedProviders.length > 0,
    addedProfiles,
    addedSlots,
    addedProviders,
  };
}
