/**
 * src/docs/lib/data-source-loader.js
 *
 * Shared DataSource loader used by both scan.js and resolver-factory.js.
 *
 * Preset data/*.js modules must export a factory:
 *   `export default function register(container) { ... return SourceClass; }`
 * The loader invokes the factory with the module-level container and expects
 * it to return a class. The class is then instantiated.
 */

import fs from "fs";
import path from "path";
import { container, registerPresetBaseDependencies } from "../../lib/container.js";
import { EsmModule } from "../../lib/esm-module.js";

const MAX_DATA_SOURCE_FILES = 1000;

/**
 * Load DataSource classes from a directory and instantiate them.
 *
 * @param {string} dataDir   - data/ directory absolute path
 * @param {Object} [opts]    - Options
 * @param {Map<string, Object>} [opts.existing] - Inherited DataSource map (parent preset)
 * @param {function} [opts.onInstance] - Called with (instance, name) after instantiation.
 *   Return false to skip adding this source. Use for init() or filter logic.
 * @param {string} [opts.presetKey] - Preset key. When set, the loaded classes
 *   are also recorded into the module-level container via
 *   `container.registerPreset(key, { dataSources })` so that descendants in
 *   the same chain can access them with `container.getPreset(key)`.
 * @returns {Promise<Map<string, Object>>} name → DataSource instance
 */
export async function loadDataSources(dataDir, opts) {
  const { existing, onInstance, presetKey } = opts || {};
  // Factory loading needs the package preset API, not ambient project config,
  // logging, providers, or Flow services. CLI initialization remains separate.
  registerPresetBaseDependencies();
  const sources = new Map(existing || []);
  const loadedClasses = new Map();
  let entries;
  try {
    entries = await fs.promises.readdir(dataDir);
  } catch (err) {
    if (err.code === "ENOENT") return sources;
    throw err;
  }
  const files = entries.filter((f) => f.endsWith(".js"));
  if (files.length > MAX_DATA_SOURCE_FILES) {
    throw new Error(
      `DataSource directory ${dataDir} contains ${files.length} files, exceeding limit ${MAX_DATA_SOURCE_FILES}`,
    );
  }
  for (const file of files) {
    const name = path.basename(file, ".js");
    const filePath = path.join(dataDir, file);
    let mod;
    try {
      mod = await new EsmModule(filePath).import();
    } catch (err) {
      throw new Error(`failed to load DataSource at ${filePath}: ${err.message}`, { cause: err });
    }
    const Source = mod.default;
    if (typeof Source !== "function") continue;
    const Cls = /^class\s/.test(Function.prototype.toString.call(Source))
      ? Source
      : Source(container);
    if (typeof Cls !== "function") {
      throw new Error(
        `preset DataSource factory at ${filePath} must return a class`,
      );
    }
    const instance = new Cls();
    instance._sourceFilePath = filePath;
    if (onInstance && onInstance(instance, name) === false) continue;
    sources.set(name, instance);
    loadedClasses.set(name, Cls);
  }
  if (presetKey && loadedClasses.size > 0) {
    const previous = container.getPreset(presetKey)?.dataSources ?? {};
    const dataSources = { ...previous };
    for (const [name, cls] of loadedClasses) dataSources[name] = cls;
    container.registerPreset(presetKey, { dataSources });
  }
  return sources;
}
