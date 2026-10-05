#!/usr/bin/env node
/**
 * sennel/help.js
 *
 * Shared help renderer. Core command help is derived from command metadata,
 * and plugin command help is normalized into the same renderer input shape.
 * Help rendering must stay import-safe: it reads metadata only and never
 * imports command implementation modules or executes command behavior.
 */

import { getPackageVersion } from "./lib/cli.js";
import { loadConfig } from "./lib/config.js";
import { createI18n } from "./lib/i18n.js";
import {
  CommandHelpMetadata,
  CoreCommandMetadataRegistry,
  allCommands,
  coreCommandRegistry,
  coreCommandMetadataRegistry,
} from "./lib/command-registry.js";
import { loadPluginRegistry } from "./lib/plugin-registry.js";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_LANG = "en";

export class HelpCommandView {
  constructor(metadata, { lang = DEFAULT_LANG, parentName = null } = {}) {
    const localized = resolveLocalizedText(metadata, lang);
    this.fullName = metadata.name;
    this.name = parentName ? metadata.name.split(" ").at(-1) : metadata.name;
    this.section = metadata.section || "";
    this.summary = localized.summary;
    this.usage = localized.usage;
    this.help = localized.help;
    this.args = metadata.args || {};
    this.options = Array.isArray(metadata.options) ? metadata.options : [];
    this.experimental = Boolean(metadata.experimental);
    this.localeKey = metadata.localeKey || null;
    this.locale = metadata.locale || null;
    this.owner = metadata.owner || "core-command-metadata";
    this.subcommands = (metadata.subcommands || []).map((entry) => new HelpCommandView(entry, { lang, parentName: metadata.name }));
  }

  find(parts) {
    const [head, ...rest] = parts;
    if (!head) return this;
    const sub = this.subcommands.find((entry) => entry.name === head || entry.fullName === [this.fullName, head].join(" "));
    const found = rest.length === 0 ? sub : sub?.find(rest);
    return found?.resolved();
  }

  all() {
    return [this.resolved(), ...this.subcommands.flatMap((entry) => entry.all())];
  }

  resolved() {
    const view = Object.create(HelpCommandView.prototype);
    Object.assign(view, this, { name: this.fullName });
    return view;
  }
}

export class HelpModel {
  constructor(entries, { lang = DEFAULT_LANG } = {}) {
    this.entries = entries.map((entry) => new HelpCommandView(entry, { lang }));
  }

  findCommand(parts) {
    const normalized = Array.isArray(parts) ? parts : String(parts).split(/\s+/);
    const [head, ...rest] = normalized;
    const top = this.entries.find((entry) => entry.name === head);
    if (!top) throw new Error(`unknown command metadata: ${normalized.join(" ")}`);
    if (rest.length === 0) return top;
    const found = top.find(rest);
    if (!found) throw new Error(`unknown command metadata: ${normalized.join(" ")}`);
    return found;
  }

  topLevelCommands() {
    return this.entries.flatMap((entry) => entry.subcommands.length ? entry.subcommands : [entry]);
  }

  allCommands() {
    return this.entries.flatMap((entry) => entry.all());
  }
}

function i18n(lang) {
  return createI18n(lang || DEFAULT_LANG, { domain: "ui" });
}

function resolveLang(root, lang) {
  if (lang) return lang;
  try {
    const config = loadConfig(root, { allowMissingType: true });
    return config.lang || config.docs?.defaultLanguage || DEFAULT_LANG;
  } catch (_) {
    return DEFAULT_LANG;
  }
}

function normalizeLocaleKey(key) {
  return String(key || "").replace(/^ui:/, "");
}

class StructuredCommandHelp {
  constructor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.usage !== "string" || typeof value.desc !== "string") {
      throw new Error("structured command help requires usage and description text");
    }
    this.value = value;
    Object.freeze(this);
  }

  static from(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? new StructuredCommandHelp(value)
      : null;
  }

  get summary() {
    return this.value.desc;
  }

  get usage() {
    return this.value.usage;
  }

  toText() {
    const lines = [this.value.usage, "", this.value.desc];
    if (typeof this.value.descDetail === "string" && this.value.descDetail !== "") {
      lines.push(this.value.descDetail);
    }
    if (Array.isArray(this.value.updatedFiles) && this.value.updatedFiles.length > 0) {
      lines.push("", "Updated files:", ...this.value.updatedFiles.map((file) => `  ${file}`));
    }
    const options = this.value.options && typeof this.value.options === "object"
      ? Object.values(this.value.options).filter((option) => typeof option === "string")
      : [];
    if (options.length > 0) lines.push("", "Options:", ...options.map((option) => `  ${option}`));
    return lines.join("\n");
  }
}

function resolveLocaleValue(value, lang) {
  if (!value || typeof value !== "object") return null;
  return value[lang] || value[DEFAULT_LANG] || null;
}

function resolveLocalizedText(metadata, lang) {
  const locale = resolveLocaleValue(metadata.locale, lang);
  const t = i18n(lang);
  const localeKey = normalizeLocaleKey(metadata.localeKey);
  const translated = localeKey ? t(localeKey) : null;
  const fallback = i18n(DEFAULT_LANG);
  const fallbackTranslated = localeKey ? fallback(localeKey) : null;
  const structured = StructuredCommandHelp.from(translated);
  const fallbackStructured = StructuredCommandHelp.from(fallbackTranslated);
  const summary = locale?.summary
    || locale?.desc
    || structured?.summary
    || (translated && translated !== localeKey ? translated : null)
    || metadata.summary
    || metadata.desc
    || "";
  const usage = locale?.usage || structured?.usage || metadata.usage || `Usage: sennel ${metadata.name}`;
  const help = locale?.help || structured?.toText() || metadata.help || "";
  return {
    summary,
    usage,
    help,
    fallbackSummary: fallbackStructured?.summary
      || (fallbackTranslated && fallbackTranslated !== metadata.localeKey ? fallbackTranslated : metadata.summary),
  };
}

function registryFromPlainTree(tree) {
  const entries = [];
  for (const [name, entry] of Object.entries(tree || {})) {
    entries.push(metadataFromEntry(name, entry));
  }
  return new CoreCommandMetadataRegistry(entries);
}

function metadataFromEntry(name, entry, parent = null, inheritedSection = null) {
  if (entry instanceof CommandHelpMetadata) return entry;
  const fullName = parent ? `${parent} ${name}` : name;
  const hasCommand = typeof entry?.command === "function";
  const children = [];
  const childEntries = entry?.subcommands || (!hasCommand && entry && typeof entry === "object" ? entry : null);
  const metadataFields = new Set(["metadata", "section", "summary", "desc", "usage", "help", "args", "options", "experimental", "localeKey", "locale", "owner", "subcommands"]);
  if (childEntries && typeof childEntries === "object") {
    for (const [childName, childEntry] of Object.entries(childEntries)) {
      if (metadataFields.has(childName)) continue;
      children.push(metadataFromEntry(childName, childEntry, fullName, entry?.section || inheritedSection));
    }
  }
  if (entry?.metadata instanceof CommandHelpMetadata) return entry.metadata;
  return new CommandHelpMetadata({
    name: fullName,
    section: entry?.section || inheritedSection || (parent ? titleCase(parent) : titleCase(name)),
    summary: entry?.summary || entry?.desc || fullName,
    usage: entry?.help?.split(/\r?\n/, 1)[0] || `Usage: sennel ${fullName}`,
    help: entry?.help || "",
    args: entry?.args || {},
    options: entry?.args?.flags || [],
    experimental: Boolean(entry?.experimental),
    localeKey: entry?.localeKey || null,
    subcommands: children,
  });
}

function resolveCoreRegistry(commands = null) {
  if (!commands || commands === coreCommandRegistry) return coreCommandRegistry.metadataRegistry();
  if (commands === allCommands || commands === coreCommandMetadataRegistry) {
    return coreCommandMetadataRegistry;
  }
  if (typeof commands.metadataRegistry === "function") return commands.metadataRegistry();
  if (commands instanceof CoreCommandMetadataRegistry) return commands;
  if (typeof commands.findCommand === "function" && typeof commands.allCommands === "function") return commands;
  return registryFromPlainTree(commands);
}

export function buildCoreHelpModel({ commands = coreCommandRegistry, lang = DEFAULT_LANG } = {}) {
  const registry = resolveCoreRegistry(commands);
  return new HelpModel(registry.entries || registry.allCommands(), { lang });
}

function titleCase(text) {
  return String(text || "").replace(/^./, (m) => m.toUpperCase());
}

function sectionOrder(section) {
  return ["Project", "Docs", "Flow", "Metrics", "Info", "Plugins"].indexOf(section);
}

function renderTopLevel(model, plugins, lang) {
  const t = i18n(lang);
  const commands = [...model.topLevelCommands(), ...plugins];
  const maxName = Math.max(...commands.map((command) => (command.fullName || command.name).length), 4);
  const lines = [
    "",
    `  sennel v${getPackageVersion()} - ${t("help.title")}`,
    "",
    `  ${t("help.usage")}`,
    "",
  ];
  let currentSection = null;
  for (const command of commands.sort((a, b) => {
    const sectionDiff = sectionOrder(a.section) - sectionOrder(b.section);
    return sectionDiff || a.name.localeCompare(b.name);
  })) {
    if (command.section !== currentSection) {
      currentSection = command.section;
      lines.push("");
      lines.push(`  ${currentSection}`);
    }
    const padded = (command.fullName || command.name).padEnd(maxName + 2);
    const experimental = command.experimental ? " [experimental]" : "";
    lines.push(`    ${padded}${command.summary}${experimental}`.trimEnd());
  }
  lines.push("");
  lines.push(`  ${t("help.runHelp")}`);
  lines.push("");
  return lines.join("\n");
}

function renderCommand(command) {
  if (command.help && command.subcommands.length === 0) return command.help;
  const lines = [command.usage, ""];
  if (command.summary) lines.push(command.summary);
  if (command.experimental) lines.push("", "Experimental: true");
  if (command.options.length) {
    lines.push("", "Options:");
    for (const option of command.options) lines.push(`  ${option}`);
  } else if (command.args?.flags?.length || command.args?.options?.length) {
    lines.push("", "Options:");
    for (const option of [...(command.args.flags || []), ...(command.args.options || [])]) lines.push(`  ${option}`);
  }
  if (command.args?.positional?.length) {
    lines.push("", "Arguments:");
    for (const arg of command.args.positional) lines.push(`  ${arg}`);
  }
  if (command.subcommands.length) {
    lines.push("", "Subcommands:");
    for (const sub of command.subcommands) {
      const shortName = sub.name.split(" ").at(-1);
      lines.push(`  ${shortName.padEnd(14)}${sub.summary}`.trimEnd());
    }
  }
  return lines.join("\n");
}

function pluginCommands(root, lang) {
  return [...loadPluginRegistry(root).commands.values()].map((command) => normalizePluginHelpMetadata(command, { lang }));
}

export function normalizePluginHelpMetadata(command, { lang = DEFAULT_LANG } = {}) {
  const localized = command.locale?.[lang] || command.locale?.[DEFAULT_LANG] || {};
  return new CommandHelpMetadata({
    name: command.name,
    section: "Plugins",
    summary: localized.desc || command.desc || command.description || command.summary || "",
    usage: localized.help || command.help || `Usage: sennel ${command.name}`,
    args: command.args || {},
    options: command.options || command.args?.flags || [],
    experimental: Boolean(command.experimental),
    localeKey: `plugin:${command.providerId || "plugin"}.${command.name}`,
    locale: command.locale || null,
    owner: "plugin-command-metadata",
    subcommands: (command.subcommands || []).map((sub) => {
      const subLocalized = sub.locale?.[lang] || sub.locale?.[DEFAULT_LANG] || {};
      return new CommandHelpMetadata({
        name: sub.name,
        section: "Plugins",
        summary: subLocalized.desc || sub.desc || sub.description || sub.summary || "",
        usage: subLocalized.help || sub.help || `Usage: sennel ${command.name} ${sub.name}`,
        args: sub.args || {},
        options: sub.options || sub.args?.flags || [],
        experimental: Boolean(sub.experimental),
        localeKey: `plugin:${command.providerId || "plugin"}.${command.name}.${sub.name}`,
        locale: sub.locale || null,
        owner: "plugin-command-metadata",
      });
    }),
  });
}

function findPluginPackage(registry, id) {
  return registry.manifests.find((manifest) => manifest.providerId === id || manifest.name === id) || null;
}

export async function renderPluginPackageHelp({ root = process.cwd(), plugin, lang = DEFAULT_LANG } = {}) {
  const registry = loadPluginRegistry(root);
  const manifest = findPluginPackage(registry, plugin);
  if (!manifest) throw new Error(`unknown plugin: ${plugin}`);
  const commands = [...registry.commands.values()]
    .filter((command) => command.providerId === manifest.providerId)
    .map((command) => normalizePluginHelpMetadata(command, { lang }));
  const lines = [`Plugin: ${manifest.providerId}`, "", "Commands:"];
  for (const command of commands) lines.push(`  ${command.name.padEnd(14)}${command.summary}`.trimEnd());
  return lines.join("\n");
}

function coreTopicFromArgs(args) {
  const clean = args.filter((arg) => !HELP_FLAGS.has(arg));
  if (clean[0] === "help") return clean.slice(1);
  return clean;
}

export function resolveHelpSurfaceOwner(args = [], { root = process.cwd() } = {}) {
  const topic = coreTopicFromArgs(args);
  if (topic.length === 0) {
    return { owner: "renderer-backed-metadata", source: "core-command-metadata-registry", topic: [] };
  }
  const registry = loadPluginRegistry(root);
  const pluginPackage = findPluginPackage(registry, topic[0]);
  if (pluginPackage && topic.length === 1) {
    return {
      owner: "renderer-backed-metadata",
      kind: "plugin-package",
      packageId: pluginPackage.providerId,
      topic,
    };
  }
  const pluginCommand = registry.resolveCommand(topic[0]);
  if (pluginCommand) return { owner: "renderer-backed-metadata", topic };
  if (coreCommandMetadataRegistry.findCommand(topic)) {
    return { owner: "renderer-backed-metadata", source: "core-command-metadata-registry", topic };
  }
  return { owner: "unknown", topic };
}

export function resolveExecutionOwner(args = []) {
  const [head, second] = args;
  if (head === "flow" && second === "review") return { owner: "plugin-hook-dispatch" };
  if (head === "flow") return { owner: "flow-lifecycle-registry" };
  if (["docs", "check", "metrics", "spec", "hook"].includes(head)) return { owner: "core-dispatcher" };
  if (["setup", "upgrade", "plugin", "presets"].includes(head)) return { owner: "independent-entrypoint" };
  return { owner: "unknown" };
}

export function resolvePluginDiscoveryMode() {
  return "contribution-only";
}

export async function renderCommandHelp({
  root = process.cwd(),
  command = [],
  lang = null,
  commands = coreCommandRegistry,
} = {}) {
  const effectiveLang = resolveLang(root, lang);
  const topic = Array.isArray(command) ? command : String(command).split(/\s+/);
  const plugins = pluginCommands(root, effectiveLang);
  const plugin = plugins.find((entry) => entry.name === topic[0]);
  if (plugin) {
    const target = topic.length === 1 ? plugin : plugin.find(topic.slice(1));
    if (!target) throw new Error(`unknown plugin command help: ${topic.join(" ")}`);
    return renderCommand(target);
  }
  const model = buildCoreHelpModel({ commands, lang: effectiveLang });
  return renderCommand(model.findCommand(topic));
}

export async function renderHelp({ root = process.cwd(), argv = [], lang = null, commands = coreCommandRegistry } = {}) {
  const effectiveLang = resolveLang(root, lang);
  const topic = coreTopicFromArgs(argv);
  const registry = loadPluginRegistry(root);
  if (topic.length > 0) {
    const pluginPackage = findPluginPackage(registry, topic[0]);
    if (pluginPackage && topic.length === 1) return renderPluginPackageHelp({ root, plugin: topic[0], lang: effectiveLang });
    return renderCommandHelp({ root, command: topic, lang: effectiveLang, commands });
  }
  const model = buildCoreHelpModel({ commands, lang: effectiveLang });
  const plugins = commands === allCommands
    || commands === coreCommandRegistry
    || commands === coreCommandMetadataRegistry
    || !commands
    ? pluginCommands(root, effectiveLang)
    : [];
  return renderTopLevel(model, plugins, effectiveLang);
}

async function main() {
  console.log(await renderHelp({ root: process.cwd(), argv: process.argv.slice(2) }));
}

export { main, coreCommandMetadataRegistry as commands };
