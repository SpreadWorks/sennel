import crypto from "node:crypto";
import path from "node:path";

import { AtomicFile } from "./atomic-file.js";
import { AtomicJsonFile } from "./atomic-json-file.js";
import { PRODUCT } from "./product.js";
import { RealDirectoryAuthority, RealDirectoryOperationError } from "./real-directory-authority.js";

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
    let stagingAuthority = null;
    let backupAuthority = null;
    let installedAuthority = null;
    let stagingMoved = false;
    let backupCleanupStarted = false;

    const moveDirectory = (authority, target, operation) => authority.moveTo(target, {
      commitGuard() {
        installation.faultInjector({
          phase: "rename", operation, destinationPath: destination,
          stagingPath: staging, backupPath: backup,
        });
      },
    });
    const removeDirectory = (authority, operation) => {
      installation.faultInjector({ phase: "cleanup", operation, directoryPath: authority.directory });
      authority.removeTree();
    };

    try {
      installation.faultInjector({ phase: "copy", stagingPath: staging });
      installation.stagePackage(staging);
      stagingAuthority = new RealDirectoryAuthority(staging, { parentAuthority: pluginsAuthority });
      stagingAuthority.assertStable();

      installation.faultInjector({ phase: "validation", stagingPath: staging });
      installation.validateStaging(staging);

      const originalAuthority = new RealDirectoryAuthority(destination, { parentAuthority: pluginsAuthority });
      if (originalAuthority.exists()) {
        backupAuthority = moveDirectory(originalAuthority, backup, "backup");
      }
      installedAuthority = moveDirectory(stagingAuthority, destination, "swap");
      stagingMoved = true;

      installation.configTransaction.commit(installation.faultInjector);
      const installed = installation.readInstalled(destination);
      installedAuthority.assertStable();
      if (backupAuthority !== null) {
        installation.faultInjector({ phase: "cleanup", operation: "backup", directoryPath: backup });
        installedAuthority.assertStable();
        // Recursive removal can delete only part of the original tree before
        // failing. Once it starts, neither tree may be discarded for rollback.
        backupCleanupStarted = true;
        backupAuthority.removeTree();
        backupAuthority = null;
      }
      installedAuthority.assertStable();
      return installed;
    } catch (primaryError) {
      const rollbackErrors = installation.configTransaction.rollback();
      const packageRecoveryUnknown = backupCleanupStarted
        || RealDirectoryAuthority.isAuthorityFailure(primaryError)
        || (primaryError instanceof RealDirectoryOperationError && primaryError.committedToVisibleName);
      if (packageRecoveryUnknown) {
        rollbackErrors.push(new Error(`plugin rollback could not verify package restoration; recovery paths: ${destination}, ${backup}, ${staging}`));
      } else {
        if (installedAuthority !== null) {
          try {
            removeDirectory(installedAuthority, "installed");
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        if (backupAuthority !== null) {
          try {
            moveDirectory(backupAuthority, destination, "restore");
            backupAuthority = null;
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        try {
          if (!stagingMoved) {
            stagingAuthority ??= new RealDirectoryAuthority(staging, { parentAuthority: pluginsAuthority });
            if (stagingAuthority.exists()) removeDirectory(stagingAuthority, "staging");
          }
        } catch (error) {
          rollbackErrors.push(error);
        }
        if (backupAuthority !== null) {
          rollbackErrors.push(new Error(`plugin rollback retained recovery backup: ${backup}`));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...rollbackErrors],
          "plugin install failed and rollback was incomplete",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
  }
}
