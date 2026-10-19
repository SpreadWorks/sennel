import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AtomicFile } from "./atomic-file.js";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { PRODUCT } from "./product.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";

export class PluginConfigRevisionConflict extends Error {
  constructor(filePath) {
    super(`plugin config changed before commit or rollback: ${filePath}`);
    this.name = "PluginConfigRevisionConflict";
    this.code = "PLUGIN_CONFIG_REVISION_CONFLICT";
  }
}

class PluginConfigUpdate {
  #originalBytes;
  #proposedBytes;
  #proposedValue;
  #published = false;

  constructor(filePath, proposedValue) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("plugin config path is required");
    }
    if (!proposedValue || typeof proposedValue !== "object" || Array.isArray(proposedValue)) {
      throw new Error("plugin config value must be an object");
    }
    this.filePath = path.resolve(filePath);
    this.#proposedValue = structuredClone(proposedValue);
    this.#proposedBytes = Buffer.from(`${JSON.stringify(this.#proposedValue, null, 2)}\n`);
    this.#originalBytes = new AtomicFile(this.filePath).read(null);
  }

  get changed() {
    return this.#originalBytes == null || !this.#originalBytes.equals(this.#proposedBytes);
  }

  assertCurrent() {
    this.#assertBytes(this.#originalBytes);
  }

  #assertBytes(expected) {
    const current = new AtomicFile(this.filePath).read(null);
    const unchanged = current == null
      ? expected == null
      : expected != null && current.equals(expected);
    if (!unchanged) throw new PluginConfigRevisionConflict(this.filePath);
  }

  commit(faultInjector) {
    if (!this.changed) return;
    faultInjector({ phase: "config-commit", filePath: this.filePath });
    try {
      new AtomicJsonFile(this.filePath, { faultInjector, commitGuard: () => this.assertCurrent() }).write(this.#proposedValue);
      this.#published = true;
    } catch (error) {
      if (error.committedToVisibleName) this.#published = true;
      throw error;
    }
  }

  restore() {
    if (!this.#published) return;
    const writer = new AtomicFile(this.filePath, { commitGuard: () => this.#assertBytes(this.#proposedBytes) });
    if (this.#originalBytes == null) {
      writer.remove();
    } else {
      writer.write(this.#originalBytes);
    }
    this.#published = false;
  }
}

export class PluginConfigTransaction {
  constructor(updates) {
    if (!Array.isArray(updates)) throw new Error("plugin config updates must be an array");
    this.updates = Object.freeze(updates.map(({ filePath, value }) => (
      new PluginConfigUpdate(filePath, value)
    )));
    this.attempted = false;
  }

  commit(faultInjector) {
    for (const update of this.updates) update.assertCurrent();
    this.attempted = true;
    for (const update of this.updates) update.commit(faultInjector);
  }

  rollback() {
    if (!this.attempted) return [];
    const errors = [];
    for (const update of [...this.updates].reverse()) {
      try {
        update.restore();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}

export class PluginInstallation {
  constructor({
    root,
    pluginId,
    stagePackage,
    validateStaging,
    readInstalled,
    configTransaction,
    faultInjector = () => {},
  }) {
    if (typeof root !== "string" || root.trim() === "") throw new Error("plugin install root is required");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) throw new Error(`invalid plugin install id: ${pluginId}`);
    if (typeof stagePackage !== "function") throw new Error("plugin staging operation is required");
    if (typeof validateStaging !== "function") throw new Error("plugin staging validator is required");
    if (typeof readInstalled !== "function") throw new Error("installed plugin reader is required");
    if (!(configTransaction instanceof PluginConfigTransaction)) {
      throw new Error("plugin config transaction is required");
    }
    this.root = path.resolve(root);
    this.pluginId = pluginId;
    this.stagePackage = stagePackage;
    this.validateStaging = validateStaging;
    this.readInstalled = readInstalled;
    this.configTransaction = configTransaction;
    this.faultInjector = faultInjector;
    Object.freeze(this);
  }
}

export class PluginInstaller {
  install(installation) {
    if (!(installation instanceof PluginInstallation)) {
      throw new Error("PluginInstallation is required");
    }
    const pluginsRoot = path.join(installation.root, PRODUCT.managedPath("plugins"));
    const pluginsAuthority = RealDirectoryAuthority.resolve(pluginsRoot, { create: true });
    const nonce = crypto.randomUUID();
    const destination = path.join(pluginsRoot, installation.pluginId);
    const staging = path.join(pluginsRoot, `.${installation.pluginId}.staging-${nonce}`);
    const backup = path.join(pluginsRoot, `.${installation.pluginId}.backup-${nonce}`);
    let backupCreated = false;
    let swapped = false;

    try {
      installation.faultInjector({ phase: "copy", stagingPath: staging });
      installation.stagePackage(staging);
      pluginsAuthority.assertStable();
      new RealDirectoryAuthority(staging, { parentAuthority: pluginsAuthority }).assertStable();

      installation.faultInjector({ phase: "validation", stagingPath: staging });
      installation.validateStaging(staging);

      if (fs.existsSync(destination)) {
        const stat = fs.lstatSync(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`installed plugin destination must be a real directory: ${destination}`);
        }
        installation.faultInjector({
          phase: "rename",
          operation: "backup",
          destinationPath: destination,
          stagingPath: staging,
        });
        pluginsAuthority.assertStable();
        fs.renameSync(destination, backup);
        backupCreated = true;
      }
      installation.faultInjector({
        phase: "rename",
        operation: "swap",
        destinationPath: destination,
        stagingPath: staging,
      });
      pluginsAuthority.assertStable();
      fs.renameSync(staging, destination);
      swapped = true;

      installation.configTransaction.commit(installation.faultInjector);
      const installed = installation.readInstalled(destination);
      if (backupCreated) fs.rmSync(backup, { recursive: true, force: true });
      return installed;
    } catch (primaryError) {
      const rollbackErrors = installation.configTransaction.rollback();
      if (swapped && fs.existsSync(destination)) {
        try {
          fs.rmSync(destination, { recursive: true, force: true });
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (backupCreated && fs.existsSync(backup) && !fs.existsSync(destination)) {
        try {
          fs.renameSync(backup, destination);
          backupCreated = false;
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (fs.existsSync(staging)) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (backupCreated && fs.existsSync(backup) && fs.existsSync(destination)) {
        rollbackErrors.push(new Error(`plugin rollback retained recovery backup: ${backup}`));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...rollbackErrors],
          "plugin install failed and rollback was incomplete",
          { cause: primaryError },
        );
      }
      throw primaryError;
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}
