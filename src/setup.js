#!/usr/bin/env node
/**
 * sennel/setup/setup.js
 *
 * Interactive setup wizard.
 * Registers a project and generates .sennel/config.json.
 *
 * Usage:
 *   sennel setup
 *   sennel setup --name myapp --path /path/to/src --type webapp/cakephp2
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { parseArgs } from "./lib/cli.js";
import { coreCommandRegistry } from "./lib/command-registry.js";
import { EXIT_ERROR } from "./lib/constants.js";
import { validate } from "./lib/config.js";
import { DEFAULT_LANG, managedDir as managedDirFn } from "./lib/config.js";
import { createI18n } from "./lib/i18n.js";
import { listSetupPresetCandidates, resolveMultiChains, resolvePresetCandidateChains, validatePresetCandidateChain } from "./lib/presets.js";
import { buildTreeItems, select } from "./lib/multi-select.js";
import {
  AGENTS_FLOW_DIRECTIVE_RE,
  buildAgentConfigContent,
} from "./lib/agent-config-files.js";
import { resolveWorkDir } from "./lib/config.js";
import { defaultAgentProfiles } from "./lib/agent-defaults.js";
import { deploySkills } from "./lib/skills.js";
import { MANAGED_GITIGNORE_LINES, hasManagedGitignore, normalizeManagedGitignore } from "./lib/gitignore.js";
import { MANAGED_ANALYSIS_GITATTRIBUTE, normalizeManagedGitattributes } from "./lib/gitattributes.js";
import { ensureSetupOfficialPresetState, resolveSetupOfficialPresetSource } from "./lib/plugin-registry.js";
import { ExecutionMode, WritePlan } from "./lib/execution-plan.js";
import { flowSpecRootFromConfig } from "./lib/flow-workspace.js";

// ---------------------------------------------------------------------------
// readline helpers
// ---------------------------------------------------------------------------

function ask(prompt, prefill) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    if (prefill) rl.write(prefill);
  });
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseSetupArgs(argv) {
  return parseArgs(argv, coreCommandRegistry.find(["setup"]).args);
}

// ---------------------------------------------------------------------------
// Agent setup intent
// ---------------------------------------------------------------------------

const SETUP_AGENT_FAMILIES = ["claude", "codex"];
const SETUP_AGENT_FILE_BY_FAMILY = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
};
const SETUP_PROFILE_BY_INTENT = {
  "claude": "claude-only",
  "codex": "codex-only",
  "claude,codex:claude": "claude-main",
  "claude,codex:codex": "codex-main",
};
const SETUP_INTENT_BY_PROFILE = {
  "claude-only": { selectedAgents: ["claude"], mainAgent: "claude" },
  "codex-only": { selectedAgents: ["codex"], mainAgent: "codex" },
  "claude-main": { selectedAgents: ["claude", "codex"], mainAgent: "claude" },
  "codex-main": { selectedAgents: ["claude", "codex"], mainAgent: "codex" },
};
const SETUP_BUILT_IN_PROFILE_ORDER = [
  "claude-only",
  "codex-only",
  "claude-main",
  "codex-main",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSetupAgentFamily(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "claude" || raw.startsWith("claude/")) return "claude";
  if (raw === "codex" || raw.startsWith("codex/")) return "codex";
  return "";
}

function normalizeSelectedAgents(values) {
  const selected = [];
  for (const value of values || []) {
    const family = normalizeSetupAgentFamily(value);
    if (family && !selected.includes(family)) selected.push(family);
  }
  return selected;
}

function setupIntentFromProfile(profileName) {
  const intent = SETUP_INTENT_BY_PROFILE[profileName];
  return intent ? clone(intent) : null;
}

export function resolveSetupAgentDefaults(agent = {}) {
  const fromProfile = setupIntentFromProfile(agent.useProfile);
  if (fromProfile) return fromProfile;

  const family = normalizeSetupAgentFamily(agent.default);
  if (family) return { selectedAgents: [family], mainAgent: family };

  return { selectedAgents: [], mainAgent: "" };
}

export function parseSetupAgentOption(value) {
  const selectedAgents = normalizeSelectedAgents(String(value || "").split(","));
  const mainAgent = selectedAgents[0] || "";
  return { selectedAgents, mainAgent };
}

export function buildSetupAgentConfig({ selectedAgents, mainAgent }) {
  const agents = normalizeSelectedAgents(selectedAgents);
  if (agents.length === 0) return null;

  const main = normalizeSetupAgentFamily(mainAgent) || agents[0];
  const profileKey = agents.length === 1
    ? agents[0]
    : `${[...SETUP_AGENT_FAMILIES].sort().join(",")}:${main}`;
  const useProfile = SETUP_PROFILE_BY_INTENT[profileKey];
  if (!useProfile) {
    throw new Error(`unsupported setup agent intent: ${agents.join(",")} main=${main}`);
  }

  return { default: main, useProfile, workDir: ".tmp" };
}

export function resolveSetupAgentFileTargets({ selectedAgents, mode, selectedTargets = [] } = {}) {
  const agents = normalizeSelectedAgents(selectedAgents);
  if (agents.length === 0) return [];
  if (agents.length === 1) return [SETUP_AGENT_FILE_BY_FAMILY[agents[0]]];
  if (mode === "interactive" && selectedTargets.length > 0) {
    return selectedTargets.filter((target) => target === "AGENTS.md" || target === "CLAUDE.md");
  }
  return ["AGENTS.md", "CLAUDE.md"];
}

export function buildSetupAgentPromptPlan({ selectedAgents = [], mainAgent = "", selectedTargets = [] } = {}) {
  const agents = normalizeSelectedAgents(selectedAgents);
  const prompts = [
    {
      id: "availableAgents",
      mode: "multi",
      options: SETUP_AGENT_FAMILIES.map((key) => ({ key })),
    },
  ];

  const result = { selectedAgents: agents, mainAgent, agentFileTargets: [] };
  if (agents.length > 1) {
    prompts.push({
      id: "mainAgent",
      mode: "single",
      options: agents.map((key) => ({ key })),
    });
    prompts.push({
      id: "agentFileTargets",
      mode: "multi",
      options: [
        { key: "AGENTS.md" },
        { key: "CLAUDE.md" },
      ],
    });
    result.mainAgent = normalizeSetupAgentFamily(mainAgent) || agents[0];
    result.agentFileTargets = resolveSetupAgentFileTargets({
      selectedAgents: agents,
      mode: "interactive",
      selectedTargets,
    });
  } else if (agents.length === 1) {
    prompts.push({
      id: "agentFileMode",
      mode: "single",
      options: [
        { key: "generate" },
        { key: "skip" },
      ],
    });
    result.mainAgent = agents[0];
    result.agentFileTargets = resolveSetupAgentFileTargets({ selectedAgents: agents });
  }

  return { ...result, prompts };
}

export function buildSetupAgentHelpText() {
  const profileNames = setupBuiltInProfileNames().join(", ");
  return [
    "agent.default stores the selected family alias: claude or codex.",
    `agent.useProfile stores one built-in profile name: ${profileNames}.`,
    "Built-in agent.profiles and agent.providers are resolved by sennel at runtime.",
    "Override a built-in profile/provider by defining the same key in config.json.",
    'Example "agent.profiles": { "codex-main": { "docs.readme": "my-codex" } }',
    'Example "agent.providers": { "my-codex": { "command": "codex", "args": ["exec", "{{PROMPT}}"] } }',
  ].join("\n");
}

function setupBuiltInProfileNames() {
  const names = Object.keys(defaultAgentProfiles());
  return [
    ...SETUP_BUILT_IN_PROFILE_ORDER.filter((name) => names.includes(name)),
    ...names.filter((name) => !SETUP_BUILT_IN_PROFILE_ORDER.includes(name)),
  ];
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    return null;
  }
}

function snapshotConfigFile(configPath) {
  return fs.existsSync(configPath)
    ? { exists: true, content: fs.readFileSync(configPath, "utf8") }
    : { exists: false, content: null };
}

function restoreConfigFile(configPath, snapshot) {
  if (snapshot.exists) {
    fs.writeFileSync(configPath, snapshot.content, "utf8");
  } else if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

// ---------------------------------------------------------------------------
// Load existing config as defaults
// ---------------------------------------------------------------------------

function loadExistingDefaults(workRoot) {
  const configPath = path.join(managedDirFn(workRoot), "config.json");
  const cfg = readConfigFile(configPath);
  if (!cfg) return null;
  const types = Array.isArray(cfg.type) ? cfg.type : cfg.type ? [cfg.type] : [];
  const agentDefaults = resolveSetupAgentDefaults(cfg.agent || {});
  return {
    projectName: cfg.name || "",
    lang: cfg.lang || DEFAULT_LANG,
    type: types[0] || "",
    additionalTypes: types.slice(1),
    outputLangs: cfg.docs?.languages || [],
    outputDefault: cfg.docs?.defaultLanguage || "",
    purpose: cfg.docs?.style?.purpose || "",
    tone: cfg.docs?.style?.tone || "",
    agent: agentDefaults.mainAgent,
    selectedAgents: agentDefaults.selectedAgents,
    mainAgent: agentDefaults.mainAgent,
    agentFileTargets: resolveSetupAgentFileTargets({
      selectedAgents: agentDefaults.selectedAgents,
      mode: "interactive",
    }),
  };
}

export const loadSetupDefaults = loadExistingDefaults;

// ---------------------------------------------------------------------------
// Project registration
// ---------------------------------------------------------------------------

function ensureProjectDirs(workRoot) {
  const projectManagedDir = managedDirFn(workRoot);
  const outputDir = path.join(projectManagedDir, "output");
  const docsDir = path.join(workRoot, "docs");
  [projectManagedDir, outputDir, docsDir].forEach((d) =>
    fs.mkdirSync(d, { recursive: true }),
  );
  fs.writeFileSync(path.join(outputDir, ".gitkeep"), "");
}

function ensureGitignore(workRoot) {
  const rootGitignore = path.join(workRoot, ".gitignore");
  const block = [
    ".tmp/",
    "",
    ...MANAGED_GITIGNORE_LINES,
    "",
    ".agents/*",
    "!.agents/skills*",
    ".claude/*",
    "!.claude/skills*",
    ".codex",
  ];
  if (fs.existsSync(rootGitignore)) {
    const content = fs.readFileSync(rootGitignore, "utf8");
    const normalized = normalizeManagedGitignore(content, { appendIfMissing: false });
    if (normalized !== content) {
      fs.writeFileSync(rootGitignore, normalized, "utf8");
    }
    if (hasManagedGitignore(normalized)) return;
    const prefix = normalized.endsWith("\n") || normalized === "" ? "" : "\n";
    fs.appendFileSync(rootGitignore, `${prefix}${block.join("\n")}\n`);
  } else {
    fs.writeFileSync(rootGitignore, `${block.join("\n")}\n`);
  }
}

function ensureGitattributes(workRoot) {
  const gitattributesPath = path.join(workRoot, ".gitattributes");
  if (fs.existsSync(gitattributesPath)) {
    const content = fs.readFileSync(gitattributesPath, "utf8");
    const normalized = normalizeManagedGitattributes(content);
    if (normalized !== content) fs.writeFileSync(gitattributesPath, normalized, "utf8");
  } else {
    fs.writeFileSync(gitattributesPath, `${MANAGED_ANALYSIS_GITATTRIBUTE}\n`);
  }
}

function resolveProjectRoot(sourcePath, workRootPath, t) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(t("common.error.pathNotFound", { path: resolved }));
  }

  return workRootPath ? path.resolve(workRootPath) : resolved;
}

function registerProject(sourcePath, workRootPath, t) {
  const workRoot = resolveProjectRoot(sourcePath, workRootPath, t);
  ensureProjectDirs(workRoot);
  ensureGitignore(workRoot);
  ensureGitattributes(workRoot);

  return { workRoot };
}

// ---------------------------------------------------------------------------
// Agent config file (CLAUDE.md / AGENTS.md) setup
// ---------------------------------------------------------------------------

function buildAgentContent(lang, options = {}) {
  return buildAgentConfigContent(lang, options);
}

function ensureAgentConfigFile(filePath, lang, t, options = {}) {
  const fileName = path.basename(filePath);
  const agentContent = buildAgentContent(lang, options);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, agentContent + "\n", "utf8");
    console.log(t("setup.messages.agentFileCreated", { file: fileName }));
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");

  if (AGENTS_FLOW_DIRECTIVE_RE.test(content)) {
    const flowBlock = agentContent.match(AGENTS_FLOW_DIRECTIVE_RE)?.[0];
    if (flowBlock) {
      const updated = content.replace(AGENTS_FLOW_DIRECTIVE_RE, flowBlock);
      if (updated !== content) {
        fs.writeFileSync(filePath, updated, "utf8");
        console.log(t("setup.messages.agentFileUpdated", { file: fileName }));
      } else {
        console.log(t("setup.messages.agentFileUpToDate", { file: fileName }));
      }
    }
    return;
  }

  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(filePath, content + separator + agentContent + "\n", "utf8");
  console.log(t("setup.messages.agentFileUpdated", { file: fileName }));
}

function fixClaudeMdSymlink(sourceDir) {
  const claudePath = path.join(sourceDir, "CLAUDE.md");
  try {
    const stat = fs.lstatSync(claudePath);
    if (stat.isSymbolicLink()) {
      const content = fs.readFileSync(claudePath, "utf8");
      fs.unlinkSync(claudePath);
      fs.writeFileSync(claudePath, content, "utf8");
    }
  } catch (err) { if (err.code !== "ENOENT") console.error(err); }
}

export function writeSetupAgentFiles({ workRoot, lang, agentFileTargets, presetTypes, t }) {
  const targets = Array.isArray(agentFileTargets) ? agentFileTargets : [];
  if (targets.includes("CLAUDE.md")) fixClaudeMdSymlink(workRoot);
  for (const target of targets) {
    ensureAgentConfigFile(path.join(workRoot, target), lang, t, {
      projectRoot: workRoot,
      presetTypes,
    });
  }
}

function officialPresetCandidateOptions(projectRoot, { defaultOfficialPresetSource } = {}) {
  const official = resolveSetupOfficialPresetSource(projectRoot, { defaultOfficialPresetSource });
  return {
    includeOfficialPresets: true,
    officialPresetRoot: official.root,
    officialPresetSource: official.source,
  };
}

function listInteractiveSetupPresetCandidates(projectRoot, options = {}) {
  return listSetupPresetCandidates(projectRoot, officialPresetCandidateOptions(projectRoot, options));
}

export const listSetupWizardPresetCandidates = listInteractiveSetupPresetCandidates;

// ---------------------------------------------------------------------------
// Interactive wizard (returns settings object)
// ---------------------------------------------------------------------------

async function runWizard(defaults, t, { projectRoot } = {}) {
  const s = { ...defaults };

  // --- Project name ---
  s.projectName = await ask(
    t("setup.questions.projectName", { default: s.projectName }),
    s.projectName,
  );
  if (!s.projectName) s.projectName = defaults.projectName;

  // --- Output language ---
  const outputLangList = t.raw("setup.choices.outputLang");
  const outputLangItems = outputLangList.map((item) => ({
    key: item.key,
    label: item.label,
  }));
  console.log(`\n${t("setup.questions.outputLang")}`);
  s.outputLangs = await select(outputLangItems, {
    mode: "multi",
    default: s.outputLangs,
  });
  if (s.outputLangs.length === 0) s.outputLangs = [s.lang];

  if (s.outputLangs.length === 1) {
    s.outputDefault = s.outputLangs[0];
  } else {
    const defaultChoices = t.raw("setup.choices.outputDefault");
    const defaultItems = s.outputLangs.map((lang) => ({
      key: lang,
      label: defaultChoices[lang] || lang,
    }));
    console.log(`\n${t("setup.questions.outputDefault")}`);
    s.outputDefault = await select(defaultItems, {
      mode: "single",
      default: s.outputDefault,
    });
  }

  // --- Preset selection ---
  const treeItems = buildTreeItems(listInteractiveSetupPresetCandidates(projectRoot));
  const presetDefaults = s.additionalTypes.length > 0
    ? [s.type, ...s.additionalTypes]
    : s.type ? [s.type] : [];
  console.log(`\n${t("setup.questions.fwType")}`);
  const selectedPresets = await select(treeItems, {
    mode: "multi",
    autoSelectAncestors: true,
    default: presetDefaults,
  });
  if (selectedPresets.length === 0) {
    s.type = "base";
    s.additionalTypes = [];
  } else {
    s.type = selectedPresets[0];
    s.additionalTypes = selectedPresets.slice(1);
  }

  // --- Document purpose ---
  const purposeChoices = t.raw("setup.choices.purpose");
  console.log(`\n${t("setup.questions.purpose")}`);
  s.purpose = await select([
    { key: "developer-guide", label: purposeChoices["developer-guide"] },
    { key: "user-guide", label: purposeChoices["user-guide"] },
    { key: "api-reference", label: purposeChoices["api-reference"] },
    { key: "__other__", label: purposeChoices.other },
  ], { mode: "single", default: s.purpose });
  if (s.purpose === "__other__") {
    const BUILTIN_PURPOSES = ["developer-guide", "user-guide", "api-reference", "__other__"];
    const prefill = BUILTIN_PURPOSES.includes(defaults.purpose) ? "" : defaults.purpose;
    s.purpose = await ask(t("setup.questions.purposeCustom"), prefill);
    if (!s.purpose) s.purpose = "developer-guide";
  }

  // --- Tone ---
  const toneChoices = t.raw("setup.choices.tone");
  console.log(`\n${t("setup.questions.tone")}`);
  s.tone = await select([
    { key: "polite", label: toneChoices.polite },
    { key: "formal", label: toneChoices.formal },
    { key: "casual", label: toneChoices.casual },
  ], { mode: "single", default: s.tone });

  // --- Agent ---
  const agentChoices = t.raw("setup.choices.agent");
  console.log(`\n${t("setup.questions.agent")}`);
  s.selectedAgents = await select([
    { key: "claude", label: agentChoices.claude },
    { key: "codex", label: agentChoices.codex },
  ], { mode: "multi", default: s.selectedAgents || (s.agent ? [s.agent] : ["codex"]) });
  if (s.selectedAgents.length === 0) s.selectedAgents = ["codex"];

  if (s.selectedAgents.length === 1) {
    s.mainAgent = s.selectedAgents[0];
    s.agent = s.mainAgent;
  } else {
    console.log(`\n${t("setup.questions.mainAgent") || "Main/default AI agent:"}`);
    s.mainAgent = await select(
      s.selectedAgents.map((key) => ({ key, label: agentChoices[key] || key })),
      { mode: "single", default: s.mainAgent || s.agent || s.selectedAgents[0] },
    );
    s.agent = s.mainAgent;
  }

  // --- Agent config file ---
  const agentsChoices = t.raw("setup.choices_agents");
  if (s.selectedAgents.length === 1) {
    const agentFileName = SETUP_AGENT_FILE_BY_FAMILY[s.selectedAgents[0]];
    console.log(`\n${agentFileName}:`);
    s.agentFileMode = await select([
      { key: "generate", label: agentsChoices.rewrite },
      { key: "skip", label: agentsChoices.skip },
    ], { mode: "single", default: s.agentFileMode });
    s.agentFileTargets = s.agentFileMode === "generate" ? [agentFileName] : [];
  } else {
    console.log(`\n${t("setup.questions.agentFiles") || "Agent instruction files:"}`);
    s.agentFileTargets = await select([
      { key: "AGENTS.md", label: "AGENTS.md" },
      { key: "CLAUDE.md", label: "CLAUDE.md" },
    ], { mode: "multi", default: s.agentFileTargets || ["AGENTS.md", "CLAUDE.md"] });
    if (s.agentFileTargets.length === 0) s.agentFileTargets = ["AGENTS.md", "CLAUDE.md"];
    s.agentFileMode = s.agentFileTargets.length > 0 ? "generate" : "skip";
  }

  return s;
}

// ---------------------------------------------------------------------------
// Summary display
// ---------------------------------------------------------------------------

function resolveLeafTypes(primaryType, additionalTypes, projectRoot, candidates = null) {
  const allTypes = additionalTypes.length > 0
    ? [primaryType, ...additionalTypes] : [primaryType];
  const chains = candidates
    ? resolvePresetCandidateChains(allTypes, candidates)
    : resolveMultiChains(allTypes, projectRoot);
  return chains.map((chain) => chain[chain.length - 1].key);
}

export const resolveSetupLeafTypes = resolveLeafTypes;

function buildSummaryLines(s, t, projectRoot) {
  const candidates = listSetupPresetCandidates(projectRoot, officialPresetCandidateOptions(projectRoot));
  const leafTypes = resolveLeafTypes(s.type, s.additionalTypes, projectRoot, candidates);
  const agentConfig = buildSetupAgentConfig({
    selectedAgents: s.selectedAgents || (s.agent ? [s.agent] : []),
    mainAgent: s.mainAgent || s.agent,
  });
  const agentFileTargets = s.agentFileTargets || resolveSetupAgentFileTargets({
    selectedAgents: s.selectedAgents || (s.agent ? [s.agent] : []),
    mode: "interactive",
  });
  const builtInProfiles = setupBuiltInProfileNames().join(", ");

  return [
    `  ${t("setup.messages.summary")}`,
    `    project:    ${s.projectName}`,
    `    lang:       ${s.lang}`,
    `    output:     ${s.outputLangs.join(", ")} (default: ${s.outputDefault})`,
    `    type:       ${leafTypes.join(", ")}`,
    `    purpose:    ${s.purpose}`,
    `    tone:       ${s.tone}`,
    `    agent.default:    ${agentConfig?.default || "-"}`,
    `    agent.useProfile: ${agentConfig?.useProfile || "-"}`,
    `    built-in profiles: ${builtInProfiles}`,
    `    agent files: ${agentFileTargets.length > 0 ? agentFileTargets.join(", ") : "skip"}`,
  ];
}

export const buildSetupSummaryLines = buildSummaryLines;

export function buildSetupConfig({ existingConfig = {}, settings }) {
  const config = clone(existingConfig || {});
  const selectedTypes = settings.additionalTypes.length > 0
    ? [settings.type, ...settings.additionalTypes]
    : [settings.type];

  config.name = settings.projectName;
  config.lang = settings.lang;
  config.type = selectedTypes.length === 1 ? selectedTypes[0] : selectedTypes;
  config.docs = {
    ...config.docs,
    languages: settings.outputLangs,
    defaultLanguage: settings.outputDefault,
    style: { ...config.docs?.style, purpose: settings.purpose, tone: settings.tone },
  };
  if (!config.flow) config.flow = { merge: "squash" };

  const selectedAgents = settings.selectedAgents
    || (settings.agent ? parseSetupAgentOption(settings.agent).selectedAgents : []);
  const mainAgent = settings.mainAgent
    || parseSetupAgentOption(settings.agent || "").mainAgent
    || selectedAgents[0]
    || "";
  const agentConfig = buildSetupAgentConfig({ selectedAgents, mainAgent });
  if (agentConfig) {
    config.agent = {
      ...(config.agent || {}),
      default: agentConfig.default,
      useProfile: agentConfig.useProfile,
      workDir: config.agent?.workDir || agentConfig.workDir,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cli = parseSetupArgs(process.argv.slice(2));

  if (cli.help) {
    const tu = createI18n(cli.lang || DEFAULT_LANG);
    const h = tu.raw("help.cmdHelp.setup");
    const o = h.options;
    console.log([
      h.usage, "", `  ${h.desc}`, "", "Options:",
      `  ${o.name}`, `  ${o.path}`, `  ${o.workRoot}`, `  ${o.type}`,
      `  ${o.purpose}`, `  ${o.tone}`, `  ${o.agent}`,
      `  ${o.lang}`, `  ${o.dryRun}`, `  ${o.help}`,
      "",
      buildSetupAgentHelpText(tu),
    ].join("\n"));
    return;
  }

  const defaultPath = process.cwd();
  const sourcePath = cli.path || defaultPath;
  const workRootPath = cli.workRoot || "";
  const setupRoot = path.resolve(workRootPath || sourcePath);
  const defaultName = path.basename(setupRoot);

  // Non-interactive mode: all required values provided via CLI
  const hasAllRequired = cli.name && cli.type && cli.purpose && cli.tone;

  let settings;

  if (hasAllRequired) {
    const operatingLang = cli.lang || DEFAULT_LANG;
    const types = cli.type.includes(",") ? cli.type.split(",") : [cli.type];
    const agentIntent = parseSetupAgentOption(cli.agent || "");
    settings = {
      projectName: cli.name || defaultName,
      lang: operatingLang,
      outputLangs: [operatingLang],
      outputDefault: operatingLang,
      type: types[0],
      additionalTypes: types.slice(1),
      purpose: cli.purpose,
      tone: cli.tone,
      agent: agentIntent.mainAgent,
      selectedAgents: agentIntent.selectedAgents,
      mainAgent: agentIntent.mainAgent,
      agentFileTargets: resolveSetupAgentFileTargets({
        selectedAgents: agentIntent.selectedAgents,
        mode: "non-interactive",
      }),
      agentFileMode: agentIntent.selectedAgents.length > 0 ? "generate" : "skip",
    };
  } else {
    // Load existing config as defaults
    const existing = loadExistingDefaults(setupRoot);

    let defaults = {
      projectName: cli.name || defaultName,
      lang: cli.lang || existing?.lang || DEFAULT_LANG,
      outputLangs: existing?.outputLangs || [],
      outputDefault: existing?.outputDefault || "",
      type: cli.type || existing?.type || "",
      additionalTypes: existing?.additionalTypes || [],
      purpose: cli.purpose || existing?.purpose || "",
      tone: cli.tone || existing?.tone || "",
      agent: cli.agent || existing?.agent || "",
      selectedAgents: cli.agent
        ? parseSetupAgentOption(cli.agent).selectedAgents
        : existing?.selectedAgents || [],
      mainAgent: cli.agent
        ? parseSetupAgentOption(cli.agent).mainAgent
        : existing?.mainAgent || "",
      agentFileTargets: existing?.agentFileTargets || [],
      agentFileMode: "generate",
    };

    // --- Language selection (always in English first) ---
    let t = createI18n("en");
    console.log(`\n  ${t("setup.title")}`);
    console.log(`  ${t("setup.separator")}\n`);

    console.log(t("setup.questions.uiLang"));
    const langChoices = t.raw("setup.choices.uiLang");
    defaults.lang = await select([
      { key: "en", label: langChoices.en },
      { key: "ja", label: langChoices.ja },
    ], { mode: "single", default: defaults.lang });

    t = createI18n(defaults.lang);

    // --- Wizard loop with confirmation ---
    while (true) {
      settings = await runWizard(defaults, t, { projectRoot: setupRoot });

      // Show summary
      const lines = buildSummaryLines(settings, t, setupRoot);
      console.log("");
      for (const line of lines) console.log(line);

      // Confirm
      const confirmChoices = t.raw("setup.choices.confirm");
      console.log(`\n${confirmChoices?.prompt || "Save this configuration?"}`);
      const confirmed = await select([
        { key: "yes", label: confirmChoices?.yes || "OK" },
        { key: "no", label: confirmChoices?.no || "Edit" },
      ], { mode: "single" });

      if (confirmed === "yes") break;

      // Use current settings as defaults for next round
      defaults = { ...settings };
      console.log("");
    }
  }

  // Resolve and validate the plan without registering or writing the project.
  const t = createI18n(settings.lang);
  const workRoot = resolveProjectRoot(sourcePath, workRootPath, t);

  // Build config: merge wizard values into existing config to preserve customizations
  const configPath = path.join(managedDirFn(workRoot), "config.json");
  const selectedTypes = settings.additionalTypes.length > 0
    ? [settings.type, ...settings.additionalTypes]
    : [settings.type];
  let config = buildSetupConfig({
    existingConfig: readConfigFile(configPath) || {},
    settings,
  });

  validate(config);

  let officialPresetOptions = {};
  let setupCandidates = listSetupPresetCandidates(workRoot);
  const candidateKeys = new Set(setupCandidates.map((candidate) => candidate.key));
  const needsOfficialPresetState = selectedTypes.some((type) => type !== "base" && !candidateKeys.has(type));
  if (needsOfficialPresetState) {
    officialPresetOptions = officialPresetCandidateOptions(workRoot);
    setupCandidates = listSetupPresetCandidates(workRoot, officialPresetOptions);
  }
  const leafTypes = resolveLeafTypes(
    settings.type,
    settings.additionalTypes,
    workRoot,
    setupCandidates,
  );
  config.type = leafTypes.length === 1 ? leafTypes[0] : leafTypes;
  validate(config);

  validatePresetCandidateChain(config.type, setupCandidates, workRoot, {
    languages: config.docs?.languages || [],
    configChapters: config.chapters,
  });

  const plan = new WritePlan(`set up project at ${workRoot}`, {
    preview: `config.json:\n${JSON.stringify(config, null, 2)}`,
  });
  plan.add("register project directories, configuration, agent files, and skills", async () => {
    registerProject(sourcePath, workRootPath, t);

    const configSnapshot = snapshotConfigFile(configPath);
    try {
      ensureSetupOfficialPresetState(workRoot, {
        selectedTypes,
        officialPresetRoot: officialPresetOptions.officialPresetRoot,
        officialPresetSource: officialPresetOptions.officialPresetSource,
      });
    } catch (err) {
      restoreConfigFile(configPath, configSnapshot);
      throw err;
    }
    const preparedConfig = readConfigFile(configPath);
    if (preparedConfig?.plugin) config.plugin = preparedConfig.plugin;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    fs.mkdirSync(flowSpecRootFromConfig(config).resolve(workRoot), { recursive: true });
    console.log(t("setup.messages.configGenerated", { path: configPath }));

    if (config.agent) {
      const workDir = resolveWorkDir(workRoot, config);
      fs.mkdirSync(workDir, { recursive: true });
    }

    if (settings.agentFileMode === "generate") {
      writeSetupAgentFiles({
        workRoot,
        lang: settings.lang,
        agentFileTargets: settings.agentFileTargets || resolveSetupAgentFileTargets({
          selectedAgents: settings.selectedAgents || (settings.agent ? [settings.agent] : []),
          mode: "non-interactive",
        }),
        presetTypes: config.type,
        t,
      });
    }

    try {
      deploySkills(workRoot);
      console.log(t("setup.messages.skillsDeployed"));
    } catch (e) {
      console.error(`skill deployment failed: ${e.message}`);
      process.exit(EXIT_ERROR);
    }

    console.log(`\n  ${t("setup.messages.nextSteps")}`);
    console.log(`    ${t("setup.messages.step1")}`);
    console.log(`    ${t("setup.messages.step2")}`);
    console.log("");

    if (typeof process.stdin.unref === "function") process.stdin.unref();
  });

  return ExecutionMode.fromDryRun(cli.dryRun).execute(plan);
}


export { main };
