import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { before, after } from "node:test";

const LEGACY_PRESET_FIXTURE = {
  "sample-command": "base",
  "sample-node-command": "sample-command",
  "sample-preset": "base",
  "parent-preset": "sample-preset",
  "child-preset": "parent-preset",
  "sample-service": "base",
  "sample-endpoint": "sample-service",
  "sample-schema": "sample-service",
  "js-sample-preset": "sample-preset",
  "sample-runtime": "js-sample-preset",
  "second-preset": "js-sample-preset",
  "sample-store": "base",
  "sample-db": "sample-store",
  "sample-bucket": "base",
  "sample-object": "sample-bucket",
  "sample-platform": "base",
  "sample-worker": "sample-platform",
};

const LEGACY_PRESET_KEYS = new Set(Object.keys(LEGACY_PRESET_FIXTURE));

function configTypes(data) {
  const type = data?.type;
  return (Array.isArray(type) ? type : [type]).filter((value) => typeof value === "string");
}

function needsLegacyPresetFixture(data) {
  if (Object.prototype.hasOwnProperty.call(data || {}, "plugin")) return false;
  return configTypes(data).some((type) => LEGACY_PRESET_KEYS.has(type));
}

function withLegacyPresetPluginConfig(data) {
  const sources = data.plugin?.sources || [];
  const packages = data.plugin?.packages || [];
  if (packages.some((pkg) => pkg?.id === "legacy-test-presets")) return data;
  return {
    ...data,
    plugin: {
      ...(data.plugin || {}),
      sources: [
        ...sources,
        { id: "legacy-test-presets", type: "local", path: ".sennel/plugins/legacy-test-presets" },
      ],
      packages: [
        ...packages,
        {
          id: "legacy-test-presets",
          source: "legacy-test-presets",
          commit: "0000000000000000000000000000000000000000",
        },
      ],
    },
  };
}

function withTestPluginMetadata(data) {
  if (!Array.isArray(data?.plugin?.packages)) return data;
  let changed = false;
  const sources = [...(data.plugin.sources || [])];
  const sourceIds = new Set(sources.map((source) => source.id));
  const packages = data.plugin.packages.map((pkg) => {
    if (!pkg || typeof pkg !== "object") return pkg;
    const next = { ...pkg };
    if (!next.source) {
      next.source = next.id;
      changed = true;
    }
    if (!next.commit) {
      next.commit = "0000000000000000000000000000000000000000";
      changed = true;
    }
    if (next.source && !sourceIds.has(next.source)) {
      sources.push({ id: next.source, type: "local", path: `.sennel/plugins/${next.id}` });
      sourceIds.add(next.source);
      changed = true;
    }
    return next;
  });
  if (!changed) return data;
  return {
    ...data,
    plugin: {
      ...(data.plugin || {}),
      sources,
      packages,
    },
  };
}

function installLegacyPresetFixture(root) {
  const pluginRoot = ".sennel/plugins/legacy-test-presets";
  const presets = Object.keys(LEGACY_PRESET_FIXTURE);
  mkdirSync(join(root, pluginRoot), { recursive: true });
  writeFileSync(join(root, pluginRoot, "plugin.json"), JSON.stringify({
    name: "legacy-test-presets",
    files: ["plugin.json", "presets/"],
    contributions: {
      presets: presets.map((key) => ({ key, path: `presets/${key}` })),
    },
  }, null, 2));
  for (const key of presets) {
    const parent = LEGACY_PRESET_FIXTURE[key];
    mkdirSync(join(root, pluginRoot, "presets", key), { recursive: true });
    writeFileSync(join(root, pluginRoot, "presets", key, "preset.json"), JSON.stringify({
      parent,
      label: key,
      scan: { include: ["src/**/*.js", "lib/**/*.js", "app/**/*.php", "package.json", "composer.json"] },
      chapters: ["overview.md", "project_structure.md", "stack_and_ops.md"],
    }, null, 2));
    mkdirSync(join(root, pluginRoot, "presets", key, "templates", "ja"), { recursive: true });
    mkdirSync(join(root, pluginRoot, "presets", key, "templates", "en"), { recursive: true });
    for (const lang of ["ja", "en"]) {
      writeFileSync(join(root, pluginRoot, "presets", key, "templates", lang, "overview.md"), "# Overview\n");
      writeFileSync(join(root, pluginRoot, "presets", key, "templates", lang, "project_structure.md"), "# Structure\n");
      writeFileSync(join(root, pluginRoot, "presets", key, "templates", lang, "stack_and_ops.md"), "# Stack\n");
      writeFileSync(
        join(root, pluginRoot, "presets", key, "templates", lang, "README.md"),
        `# <!-- {{data("${key}.project.name")}} -->Project<!-- {{/data}} -->\n`,
      );
    }
  }
  for (const dataKey of presets) {
    const dataRoot = join(root, pluginRoot, "presets", dataKey, "data");
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, "modules.js"), `export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  class ModuleEntry extends AnalysisEntry { static summary = {}; }
  return class ModulesSource extends Scannable(DataSource) {
    static Entry = ModuleEntry;
    match(relPath) { return relPath.endsWith(".js"); }
    parse(absPath) {
      const entry = new ModuleEntry();
      entry.name = absPath.split("/").pop();
      entry.role = "module";
      return entry;
    }
  };
}
`);
    writeFileSync(join(dataRoot, "commands.js"), `export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  class CommandEntry extends AnalysisEntry { static summary = {}; }
  return class CommandsSource extends Scannable(DataSource) {
    static Entry = CommandEntry;
    match(relPath) { return relPath.endsWith(".js"); }
    parse(absPath) {
      const entry = new CommandEntry();
      entry.name = absPath.split("/").pop();
      entry.role = "command";
      return entry;
    }
  };
}
`);
    writeFileSync(join(dataRoot, "config.js"), `export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  class ConfigEntry extends AnalysisEntry { static summary = {}; }
  return class ConfigSource extends Scannable(DataSource) {
    static Entry = ConfigEntry;
    match(relPath) { return relPath.endsWith("AppController.php") || relPath.includes("/Config/"); }
    parse() {
      const entry = new ConfigEntry();
      entry.role = "config";
      return entry;
    }
  };
}
`);
    writeFileSync(join(dataRoot, "controllers.js"), `export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  class ControllerEntry extends AnalysisEntry { static summary = {}; }
  return class ControllersSource extends Scannable(DataSource) {
    static Entry = ControllerEntry;
    match(relPath) { return relPath.endsWith("Controller.php"); }
    parse(absPath) {
      const entry = new ControllerEntry();
      entry.className = absPath.split("/").pop().replace(/\\.php$/, "");
      entry.role = "controller";
      return entry;
    }
  };
}
`);
    writeFileSync(join(dataRoot, "models.js"), `export default function register(container) {
  const DataSource = container.get("base.DataSource");
  const Scannable = container.get("base.Scannable");
  const AnalysisEntry = container.get("base.AnalysisEntry");
  class ModelEntry extends AnalysisEntry { static summary = {}; }
  return class ModelsSource extends Scannable(DataSource) {
    static Entry = ModelEntry;
    match(relPath) { return relPath.includes("/Model/") && relPath.endsWith(".php"); }
    parse(absPath) {
      const entry = new ModelEntry();
      entry.className = absPath.split("/").pop().replace(/\\.php$/, "");
      entry.role = "model";
      return entry;
    }
  };
}
`);
  }
}

export function createTmpDir(prefix = "sennel-test-", { parent = tmpdir() } = {}) {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function removeTmpDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeJson(dir, relPath, data) {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  let value = data;
  if (relPath === ".sennel/config.json" && needsLegacyPresetFixture(data)) {
    value = withLegacyPresetPluginConfig(data);
    installLegacyPresetFixture(dir);
  }
  if (relPath === ".sennel/config.json") {
    value = withTestPluginMetadata(value);
  }
  writeFileSync(full, JSON.stringify(value, null, 2));
}

export function writeFile(dir, relPath, content = "") {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Register before/after hooks for a temporary directory and return a getter.
 * Must be called at describe-block level (not inside it()).
 *
 * @param {string} [prefix]
 * @returns {() => string} getter that returns the tmp dir path
 */
export function useTmpDir(prefix = "sennel-test-") {
  let dir;
  before(() => { dir = createTmpDir(prefix); });
  after(() => { removeTmpDir(dir); });
  return () => dir;
}
