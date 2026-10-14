import {
  accessSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TemporaryPaths } from "../src/lib/temporary-paths.js";
import { isTmpfsDirectory } from "../src/lib/filesystem-type.js";
import { sanitizeGitRepositoryEnvironment } from "../src/lib/git-repository-environment.js";

const CLEANUP_SIGNALS = Object.freeze(["SIGHUP", "SIGINT", "SIGTERM"]);
export const MINIMUM_TEST_TMPFS_BYTES = 1024n * 1024n * 1024n;
export const TEST_CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPORARY_ROOT_ENV = "SENNEL_TEST_TEMP_ROOT";

export class TestTemporaryRoot {
  #path;
  #remove;
  #removed = false;
  #owned;

  constructor(path, { remove = rmSync, owned = true } = {}) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("test temporary root path must be a non-empty string");
    }
    this.#path = path;
    this.#remove = remove;
    this.#owned = owned;
  }

  static createOnTmpfs({
    directory = "/dev/shm",
    minimumFreeBytes = MINIMUM_TEST_TMPFS_BYTES,
    access = accessSync,
    statfs = statfsSync,
    create = mkdtempSync,
    validate = TemporaryPaths.validateRealDirectory,
    remove = rmSync,
  } = {}) {
    try {
      access(directory, constants.W_OK | constants.X_OK);
      const stats = statfs(directory, { bigint: true });
      const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
      if (!isTmpfsDirectory(directory, { statfs: () => stats }) || availableBytes < BigInt(minimumFreeBytes)) {
        return null;
      }
    } catch {
      return null;
    }
    validate(directory);
    try {
      return new TestTemporaryRoot(create(join(directory, "sennel-test-")), { remove });
    } catch {
      return null;
    }
  }

  static createOnRepository({
    repositoryRoot = TEST_CHECKOUT_ROOT,
    remove = rmSync,
  } = {}) {
    const paths = new TemporaryPaths(repositoryRoot);
    return new TestTemporaryRoot(paths.create(paths.tests(), "sennel-test-"), { remove });
  }

  static select({ repositoryRoot = TEST_CHECKOUT_ROOT, environment = process.env, tmpfs = {} } = {}) {
    const sharedPath = environment[TEMPORARY_ROOT_ENV];
    if (sharedPath !== undefined) {
      const paths = new TemporaryPaths(repositoryRoot);
      const canonical = realpathSync(paths.validate(sharedPath));
      if (canonical !== resolve(sharedPath)) throw new Error("shared test temporary root must be canonical");
      const testPath = relative(paths.tests(), canonical);
      const insideTests = testPath !== "" && testPath !== ".." && !testPath.startsWith(`..${sep}`) && !isAbsolute(testPath);
      if (!insideTests && !isTmpfsDirectory(canonical)) {
        const error = new Error("shared test temporary root must stay inside project test storage or a verified tmpfs");
        error.code = "TEST_TEMPORARY_ROOT_OUTSIDE_TESTS";
        throw error;
      }
      accessSync(canonical, constants.W_OK | constants.X_OK);
      return new TestTemporaryRoot(canonical, { owned: false });
    }
    return TestTemporaryRoot.createOnTmpfs(tmpfs)
      ?? TestTemporaryRoot.createOnRepository({ repositoryRoot });
  }

  get path() {
    return this.#path;
  }

  get owned() {
    return this.#owned;
  }

  activate({
    environment = process.env,
    processEvents = process,
    terminate = (signal) => process.kill(process.pid, signal),
  } = {}) {
    const names = ["TMPDIR", TEMPORARY_ROOT_ENV, "GIT_CEILING_DIRECTORIES"];
    const previous = new Map(names.map((name) => [name, Object.hasOwn(environment, name) ? environment[name] : undefined]));
    const restoreEnvironment = () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete environment[name];
        else environment[name] = value;
      }
    };
    const cleanupAtExit = () => {
      try {
        this.remove();
      } catch {
        // The normal async completion path reports cleanup failures. During
        // process exit there is no safe recovery beyond a best-effort removal.
      }
    };
    const signalHandlers = new Map(CLEANUP_SIGNALS.map((signal) => [signal, () => {
      try {
        this.remove();
      } finally {
        removeLifecycleListeners();
        terminate(signal);
      }
    }]));
    const removeLifecycleListeners = () => {
      processEvents.removeListener("exit", cleanupAtExit);
      for (const [signal, handler] of signalHandlers) {
        processEvents.removeListener(signal, handler);
      }
    };

    environment.TMPDIR = this.#path;
    environment[TEMPORARY_ROOT_ENV] = this.#path;
    const boundary = sanitizeGitRepositoryEnvironment({}, { repositoryRoot: this.#path }).GIT_CEILING_DIRECTORIES;
    environment.GIT_CEILING_DIRECTORIES = [boundary, previous.get("GIT_CEILING_DIRECTORIES")].filter(Boolean).join(delimiter);
    processEvents.once("exit", cleanupAtExit);
    for (const [signal, handler] of signalHandlers) {
      processEvents.once(signal, handler);
    }
    return () => {
      removeLifecycleListeners();
      restoreEnvironment();
      this.remove();
    };
  }

  async use(operation, options = {}) {
    const release = this.activate(options);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  remove() {
    if (this.#removed || !this.#owned) return;
    this.#remove(this.#path, { recursive: true, force: true });
    this.#removed = true;
  }
}
