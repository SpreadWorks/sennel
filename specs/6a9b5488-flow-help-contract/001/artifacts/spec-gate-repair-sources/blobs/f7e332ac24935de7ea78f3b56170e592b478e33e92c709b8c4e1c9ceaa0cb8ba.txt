/**
 * Unified command definitions for executable dispatch and import-safe help
 * metadata. Help reads never invoke lazy handlers, because command modules
 * may have import-time side effects.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { FLOW_COMMANDS } from "../flow/registry.js";

const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class CommandHelpMetadata {
  constructor({
    name,
    section = "",
    summary = "",
    usage = "",
    help = "",
    args = {},
    options = [],
    experimental = false,
    localeKey = null,
    locale = null,
    owner = "core-command-metadata",
    subcommands = [],
  }) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("command help metadata requires a non-empty name");
    }
    this.name = name;
    this.section = section;
    this.summary = summary;
    this.usage = usage || `Usage: sennel ${name}`;
    this.help = help;
    this.args = args && typeof args === "object" ? args : {};
    this.options = Array.isArray(options) ? options : [];
    this.experimental = Boolean(experimental);
    this.localeKey = localeKey || null;
    this.locale = locale || null;
    this.owner = owner;
    this.subcommands = subcommands.map((entry) => entry instanceof CommandHelpMetadata
      ? entry
      : new CommandHelpMetadata({ ...entry, owner }));
  }

  find(parts) {
    const [head, ...rest] = parts;
    if (!head) return this;
    const sub = this.subcommands.find((entry) => (
      entry.name.split(" ").at(-1) === head || entry.name === [this.name, head].join(" ")
    ));
    return rest.length === 0 ? sub : sub?.find(rest);
  }

  all() {
    return [this, ...this.subcommands.flatMap((entry) => entry.all())];
  }
}

export class CoreCommandMetadataRegistry {
  constructor(entries) {
    this.entries = [];
    const names = new Set();
    for (const entry of entries) {
      const metadata = entry instanceof CommandHelpMetadata ? entry : new CommandHelpMetadata(entry);
      if (names.has(metadata.name)) throw new Error(`duplicate command help metadata: ${metadata.name}`);
      names.add(metadata.name);
      this.entries.push(metadata);
    }
  }

  findCommand(parts) {
    const normalized = Array.isArray(parts) ? parts : String(parts).split(/\s+/);
    const [head, ...rest] = normalized;
    const top = this.entries.find((entry) => entry.name === head);
    if (!top) return null;
    return rest.length === 0 ? top : top.find(rest);
  }

  topLevelCommands() {
    return this.entries.flatMap((entry) => entry.subcommands.length ? entry.subcommands : [entry]);
  }

  allCommands() {
    return this.entries.flatMap((entry) => entry.all());
  }
}

export class CommandEntrypoint {
  constructor({ modulePath, invocation }) {
    if (typeof modulePath !== "string" || modulePath.trim() === "") {
      throw new Error("command entrypoint modulePath is required");
    }
    if (!new Set(["main", "script"]).has(invocation)) {
      throw new Error(`invalid command entrypoint invocation: ${invocation}`);
    }
    this.moduleUrl = new URL(modulePath, import.meta.url);
    this.modulePath = fileURLToPath(this.moduleUrl);
    this.invocation = invocation;
    Object.freeze(this);
  }

  async execute(args) {
    process.argv = [process.argv[0], this.modulePath, ...args];
    const mod = await import(pathToFileURL(this.modulePath).href);
    if (this.invocation === "script") return;
    if (typeof mod.main !== "function") {
      throw new Error(`command module does not export main(): ${this.modulePath}`);
    }
    await mod.main();
  }
}

function helpText({ usage, summary, options = [] }) {
  const lines = [usage, "", summary];
  if (options.length > 0) {
    lines.push("", "Options:", ...options.map((option) => `  ${option}`));
  }
  return lines.join("\n");
}

export class CommandDefinition {
  constructor({
    name,
    command = null,
    outputMode = null,
    passthroughArgs = false,
    args = null,
    help = {},
    subcommands = [],
    entrypoint = null,
    dispatch = {},
    allowInvalidConfig = false,
    routed = false,
  }) {
    if (typeof name !== "string" || !COMMAND_NAME_RE.test(name)) {
      throw new Error(`invalid command name: ${name}`);
    }
    if (command != null && typeof command !== "function") {
      throw new Error(`command handler must be a function: ${name}`);
    }
    if (command && outputMode !== "raw" && outputMode !== "envelope") {
      throw new Error(`command outputMode is required: ${name}`);
    }
    this.name = name;
    this.command = command;
    this.outputMode = outputMode;
    this.passthroughArgs = Boolean(passthroughArgs);
    this.args = args;
    this.helpConfig = Object.freeze({ ...(typeof help === "string" ? {} : help) });
    this.help = typeof help === "string"
      ? help
      : typeof help.text === "string"
        ? help.text
        : helpText({
            usage: help.usage || `Usage: sennel ${name}`,
            summary: help.summary || "",
            options: help.options || [],
          });
    this.entrypoint = entrypoint instanceof CommandEntrypoint
      ? entrypoint
      : entrypoint
        ? new CommandEntrypoint(entrypoint)
        : null;
    this.allowInvalidConfig = Boolean(allowInvalidConfig);
    this.routed = Boolean(routed);
    Object.assign(this, dispatch);

    this.subcommands = new Map();
    for (const child of subcommands) {
      if (!(child instanceof CommandDefinition)) throw new Error(`invalid subcommand under ${name}`);
      if (this.subcommands.has(child.name)) throw new Error(`duplicate command: ${name} ${child.name}`);
      this.subcommands.set(child.name, child);
    }
    if (!this.command && !this.entrypoint && this.subcommands.size === 0 && !this.routed) {
      throw new Error(`command definition has no handler or subcommands: ${name}`);
    }
  }

  find(parts) {
    if (parts.length === 0) return this;
    const [head, ...rest] = parts;
    return this.subcommands.get(head)?.find(rest) || null;
  }

  metadata(parentPath = []) {
    const path = [...parentPath, this.name];
    return new CommandHelpMetadata({
      name: path.join(" "),
      section: this.helpConfig.section || "",
      summary: this.helpConfig.summary || "",
      usage: this.helpConfig.usage || this.help.split(/\r?\n/, 1)[0],
      help: this.help,
      args: this.args || {},
      options: this.helpConfig.options || [],
      experimental: Boolean(this.helpConfig.experimental),
      localeKey: this.helpConfig.localeKey || null,
      locale: this.helpConfig.locale || null,
      owner: this.helpConfig.owner || "core-command-metadata",
      subcommands: [...this.subcommands.values()].map((child) => child.metadata(path)),
    });
  }

  paths(parentPath = []) {
    const path = [...parentPath, this.name];
    return [path.join(" "), ...[...this.subcommands.values()].flatMap((child) => child.paths(path))];
  }

  renderHelp() {
    if (this.subcommands.size === 0) return this.help;
    const lines = [this.help, "", "Subcommands:"];
    for (const child of this.subcommands.values()) {
      lines.push(`  ${child.name.padEnd(14)}${child.helpConfig.summary || ""}`.trimEnd());
    }
    return lines.join("\n");
  }

  dispatchChildren() {
    return Object.fromEntries([...this.subcommands.values()].map((child) => [
      child.name,
      child.command || child.entrypoint ? child : child.dispatchChildren(),
    ]));
  }
}

export class CommandRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (!(definition instanceof CommandDefinition)) throw new Error("CommandDefinition is required");
    if (this.definitions.has(definition.name)) throw new Error(`duplicate command: ${definition.name}`);
    this.definitions.set(definition.name, definition);
    return definition;
  }

  find(parts) {
    const normalized = Array.isArray(parts) ? parts : String(parts).trim().split(/\s+/);
    const [head, ...rest] = normalized;
    if (!head) return null;
    return this.definitions.get(head)?.find(rest) || null;
  }

  routePaths() {
    return [...this.definitions.values()].flatMap((definition) => definition.paths()).sort();
  }

  helpPaths() {
    return this.metadataRegistry().allCommands().map((entry) => entry.name).sort();
  }

  metadataRegistry() {
    return new CoreCommandMetadataRegistry(
      [...this.definitions.values()].map((definition) => definition.metadata()),
    );
  }
}

function rawDefinition(name, modulePath, help, { args = null, passthroughArgs = true } = {}) {
  return new CommandDefinition({
    name,
    command: () => import(modulePath),
    outputMode: "raw",
    passthroughArgs,
    args,
    help,
  });
}

const docsDefinitionData = [
  ["build", "../docs/commands/build.js", "Generate docs (scan → enrich → init → data → text → readme)", "Usage: sennel docs build [options]", "ui:help.commands.docs build"],
  ["scan", "../docs/commands/scan.js", "Source code analysis → analysis.json", "Usage: sennel docs scan [options]", "ui:help.commands.docs scan"],
  ["enrich", "../docs/commands/enrich.js", "Enrich analysis entries with AI (summary/detail/chapter)", "Usage: sennel docs enrich [options]", "ui:help.commands.docs enrich"],
  ["init", "../docs/commands/init.js", "Initialize docs/ from templates", "Usage: sennel docs init [options]", "ui:help.commands.docs init"],
  ["data", "../docs/commands/data.js", "Resolve {{data}} directives with analysis data", "Usage: sennel docs data [options]", "ui:help.commands.docs data"],
  ["text", "../docs/commands/text.js", "Resolve {{text}} directives with AI", "Usage: sennel docs text --agent <name> [options]", "ui:help.commands.docs text"],
  ["readme", "../docs/commands/readme.js", "Auto-generate README.md", "Usage: sennel docs readme [options]", "ui:help.commands.docs readme"],
  ["forge", "../docs/commands/forge.js", "Iterative docs improvement (AI agent)", "Usage: sennel docs forge --prompt \"...\" [options]", "ui:help.commands.docs forge"],
  ["review", "../docs/commands/review.js", "Docs quality check", "Usage: sennel docs review [<docs-dir>]", "ui:help.commands.docs review"],
  ["translate", "../docs/commands/translate.js", "Translate docs to non-default languages", "Usage: sennel docs translate [options]", "ui:help.commands.docs translate"],
  ["changelog", "../docs/commands/changelog.js", "Generate change_log.md from the configured spec root", "Usage: sennel docs changelog [--dry-run] [<output-file>]", "ui:help.commands.docs changelog"],
  ["agents", "../docs/commands/agents.js", "Update AGENTS.md PROJECT section", "Usage: sennel docs agents [--dry-run]", "ui:help.commands.docs agents"],
];

const docsArgs = {
  init: { flags: ["--force", "--dry-run"], options: ["--type"] },
  scan: { flags: ["--stdout", "--dry-run"], optionalOptions: ["--reset"] },
  text: { flags: ["--dry-run", "--per-directive"], options: ["--agent", "--id", "--timeout"] },
};

const docsOptions = {
  init: ["--type <type>", "--force", "--dry-run", "-h, --help"],
  scan: ["--reset [cats]", "--stdout", "--dry-run", "-h, --help"],
  text: ["--agent <name>", "--id <id>", "--dry-run", "--per-directive", "--timeout <ms>", "-h, --help"],
};

const docsSubcommands = docsDefinitionData.map(([name, modulePath, summary, usage, localeKey]) => rawDefinition(
  name,
  modulePath,
  {
    section: "Docs",
    summary,
    usage,
    options: docsOptions[name] || ["-h, --help"],
    localeKey,
  },
  { args: docsArgs[name] || null },
));

function flowSummary(help, fallback) {
  return String(help || "").split(/\r?\n/).map((line) => line.trim()).find((line) => (
    line && !line.startsWith("Usage:")
  )) || fallback;
}

function flowOptions(help) {
  const lines = String(help || "").split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === "Options:");
  if (index < 0) return ["-h, --help"];
  return lines.slice(index + 1).map((line) => line.trim()).filter(Boolean);
}

const flowGroupHelp = {
  get: ["Read flow state (status, check, prompt, guardrail, ...)", "Usage: sennel flow get <key> [options]"],
  set: ["Update flow state (step, req, note, metric, ...)", "Usage: sennel flow set <key> [options]"],
  run: ["Execute flow actions (prepare-spec, gate, finalize, ...)", "Usage: sennel flow run <action> [options]"],
};

function flowDefinition(name, entry) {
  if (typeof entry?.command === "function") {
    const { command, help, args, ...dispatch } = entry;
    return new CommandDefinition({
      name,
      command,
      outputMode: "envelope",
      args: args || {},
      help: {
        section: "Flow",
        summary: flowSummary(help, `Run ${name}`),
        usage: String(help || "").split(/\r?\n/, 1)[0] || `Usage: sennel flow ${name}`,
        options: flowOptions(help),
        localeKey: entry.helpKey ? `ui:${entry.helpKey}` : null,
        text: help,
      },
      dispatch: { ...dispatch, help },
    });
  }
  const [summary, usage] = flowGroupHelp[name] || [`Flow ${name} commands`, `Usage: sennel flow ${name} <command>`];
  return new CommandDefinition({
    name,
    help: {
      section: "Flow",
      summary,
      usage,
      options: ["-h, --help", "--agent-work-dir <path>"],
      localeKey: `ui:help.commands.flow ${name}`,
    },
    subcommands: Object.entries(entry || {}).map(([childName, child]) => flowDefinition(childName, child)),
  });
}

const flowSubcommands = Object.entries(FLOW_COMMANDS).map(([name, entry]) => flowDefinition(name, entry));

function childRoute(name, help, subcommands = []) {
  return new CommandDefinition({ name, help, subcommands, routed: true });
}

const pluginSourceSubcommands = [
  ["add", "Add a plugin source", "Usage: sennel plugin source add <git URL|local path> [--ref <ref>]", ["--ref <ref>", "-h, --help"]],
  ["update", "Update plugin sources", "Usage: sennel plugin source update", ["-h, --help"]],
  ["list", "List plugin sources", "Usage: sennel plugin source list [--json]", ["--json", "-h, --help"]],
].map(([name, summary, usage, options]) => childRoute(name, {
  section: "Project",
  summary,
  usage,
  options,
  localeKey: `ui:help.commands.plugin source ${name}`,
}));

const pluginSubcommands = [
  childRoute("source", { section: "Project", summary: "Manage plugin sources", usage: "Usage: sennel plugin source <command>", options: ["-h, --help"], localeKey: "ui:help.commands.plugin source" }, pluginSourceSubcommands),
  childRoute("find", { section: "Project", summary: "Find installable plugin packages", usage: "Usage: sennel plugin find [--json]", options: ["--json", "-h, --help"], localeKey: "ui:help.commands.plugin find" }),
  childRoute("install", { section: "Project", summary: "Install a plugin package", usage: "Usage: sennel plugin install <id> [--json] [--no-upgrade]", options: ["--json", "--no-upgrade", "-h, --help"], localeKey: "ui:help.commands.plugin install" }),
  childRoute("list", { section: "Project", summary: "List installed plugin packages", usage: "Usage: sennel plugin list [--json]", options: ["--json", "-h, --help"], localeKey: "ui:help.commands.plugin list" }),
  childRoute("enable", { section: "Project", summary: "Enable an installed plugin package", usage: "Usage: sennel plugin enable <id>", options: ["-h, --help"], localeKey: "ui:help.commands.plugin enable" }),
  childRoute("disable", { section: "Project", summary: "Disable an installed plugin package", usage: "Usage: sennel plugin disable <id>", options: ["-h, --help"], localeKey: "ui:help.commands.plugin disable" }),
  childRoute("update", { section: "Project", summary: "Update installed plugin packages", usage: "Usage: sennel plugin update [name] [--json] [--no-upgrade]", options: ["--json", "--no-upgrade", "-h, --help"], localeKey: "ui:help.commands.plugin update" }),
  childRoute("sync", { section: "Project", summary: "Sync installed plugin packages", usage: "Usage: sennel plugin sync [--json]", options: ["--json", "-h, --help"], localeKey: "ui:help.commands.plugin sync" }),
];

const definitions = [
  new CommandDefinition({
    name: "help",
    entrypoint: { modulePath: "../help.js", invocation: "main" },
    allowInvalidConfig: true,
    help: { section: "Project", summary: "Show this help", usage: "Usage: sennel help [command]", options: ["-h, --help"], localeKey: "ui:help.commands.help" },
  }),
  new CommandDefinition({
    name: "setup",
    entrypoint: { modulePath: "../setup.js", invocation: "main" },
    help: { section: "Project", summary: "Register project + generate config (interactive)", usage: "Usage: sennel setup", options: ["-h, --help"], localeKey: "ui:help.commands.setup" },
  }),
  new CommandDefinition({
    name: "upgrade",
    entrypoint: { modulePath: "../upgrade.js", invocation: "main" },
    allowInvalidConfig: true,
    help: { section: "Project", summary: "Update template-derived files to latest version", usage: "Usage: sennel upgrade [--dry-run]", options: ["--dry-run", "-h, --help"], localeKey: "ui:help.cmdHelp.upgrade" },
  }),
  new CommandDefinition({
    name: "migrate",
    entrypoint: { modulePath: "../migrate.js", invocation: "main" },
    allowInvalidConfig: true,
    help: {
      section: "Project",
      summary: "Migrate project layout or Flow specifications to a revision",
      usage: "Usage: sennel migrate <layout|specs> --to 1 [--dry-run]",
      options: ["--to <revision>", "--dry-run", "-h, --help"],
      localeKey: "ui:help.commands.migrate",
    },
  }),
  new CommandDefinition({
    name: "plugin",
    entrypoint: { modulePath: "../plugin.js", invocation: "main" },
    help: { section: "Project", summary: "Manage plugin sources, packages, commands, and presets", usage: "Usage: sennel plugin <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.plugin" },
    subcommands: pluginSubcommands,
  }),
  new CommandDefinition({
    name: "docs",
    entrypoint: { modulePath: "../docs.js", invocation: "script" },
    help: { section: "Docs", summary: "Documentation commands", usage: "Usage: sennel docs <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.docs build" },
    subcommands: docsSubcommands,
  }),
  new CommandDefinition({
    name: "check",
    entrypoint: { modulePath: "../check.js", invocation: "script" },
    help: { section: "Info", summary: "Repository checks", usage: "Usage: sennel check <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.check" },
    subcommands: [
      rawDefinition("config", "../check/commands/config.js", { section: "Info", summary: "Validate project configuration", usage: "Usage: sennel check config [options]", options: ["--format <text|json>", "-h, --help"], localeKey: "ui:help.commands.check config" }),
      rawDefinition("freshness", "../check/commands/freshness.js", { section: "Info", summary: "Check generated documentation freshness", usage: "Usage: sennel check freshness [options]", options: ["-h, --help"], localeKey: "ui:help.commands.check freshness" }),
      rawDefinition("scan", "../check/commands/scan.js", { section: "Info", summary: "Check scan coverage", usage: "Usage: sennel check scan [options]", options: ["-h, --help"], localeKey: "ui:help.commands.check scan" }),
    ],
  }),
  new CommandDefinition({
    name: "metrics",
    entrypoint: { modulePath: "../metrics.js", invocation: "script" },
    help: { section: "Metrics", summary: "Metrics commands", usage: "Usage: sennel metrics <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.metrics token" },
    subcommands: [
      rawDefinition("token", "../metrics/commands/token.js", { section: "Metrics", summary: "Aggregate and display token/cache/cost metrics", usage: "Usage: sennel metrics token [options]", options: ["-h, --help"], localeKey: "ui:help.commands.metrics token" }),
      rawDefinition("review", "../metrics/commands/review.js", { section: "Metrics", summary: "Aggregate review metrics", usage: "Usage: sennel metrics review [options]", options: ["-h, --help"], localeKey: "ui:help.commands.metrics review" }),
    ],
  }),
  new CommandDefinition({
    name: "spec",
    entrypoint: { modulePath: "../spec.js", invocation: "script" },
    help: { section: "Flow", summary: "Specification commands", usage: "Usage: sennel spec <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.spec" },
    subcommands: [rawDefinition("render", "../spec/commands/render.js", { section: "Flow", summary: "Render a specification", usage: "Usage: sennel spec render [options]", options: ["-h, --help"], localeKey: "ui:help.commands.spec render" })],
  }),
  new CommandDefinition({
    name: "hook",
    entrypoint: { modulePath: "../hook.js", invocation: "script" },
    help: { section: "Info", summary: "Hook commands", usage: "Usage: sennel hook <command>", options: ["-h, --help"], localeKey: "ui:help.commands.hook" },
    subcommands: [rawDefinition("list", "../hook/commands/list.js", {
      section: "Info",
      summary: "List available flow hooks and current configured commands.",
      usage: "Usage: sennel hook list [--json]",
      options: ["--json", "-h, --help"],
      localeKey: "ui:help.commands.hook list",
    }, { args: { flags: ["--json"] }, passthroughArgs: false })],
  }),
  new CommandDefinition({
    name: "presets",
    entrypoint: { modulePath: "../presets-cmd.js", invocation: "main" },
    help: { section: "Info", summary: "Preset commands", usage: "Usage: sennel presets <command>", options: ["-h, --help"], localeKey: "ui:help.commands.presets list" },
    subcommands: [childRoute("list", { section: "Info", summary: "Show preset inheritance tree", usage: "Usage: sennel presets list", options: ["-h, --help"], localeKey: "ui:help.commands.presets list" })],
  }),
  new CommandDefinition({
    name: "flow",
    entrypoint: { modulePath: "../flow.js", invocation: "script" },
    allowInvalidConfig: true,
    help: { section: "Flow", summary: "Spec-Driven Development flow commands", usage: "Usage: sennel flow <command> [options]", options: ["-h, --help"], localeKey: "ui:help.commands.flow run" },
    subcommands: flowSubcommands,
  }),
];

export const coreCommandRegistry = new CommandRegistry(definitions);
export const coreCommandMetadataRegistry = coreCommandRegistry.metadataRegistry();

function namespaceCommands(name) {
  return coreCommandRegistry.find([name]).dispatchChildren();
}

export const flowCommands = namespaceCommands("flow");
export const docsCommands = namespaceCommands("docs");
export const checkCommands = namespaceCommands("check");
export const metricsCommands = namespaceCommands("metrics");
export const specCommands = namespaceCommands("spec");
export const hookCommands = namespaceCommands("hook");

export const allCommands = Object.fromEntries([
  ["flow", flowCommands],
  ["docs", docsCommands],
  ["check", checkCommands],
  ["metrics", metricsCommands],
  ["spec", specCommands],
  ["hook", hookCommands],
]);
