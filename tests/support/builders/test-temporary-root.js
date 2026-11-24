import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { sanitizeGitRepositoryEnvironment } from "../../../src/lib/git-repository-environment.js";
import { TEST_CHECKOUT_ROOT, TestTemporaryRootPolicy } from "../../runner/test-temporary-root-policy.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-values.js";

const CLEANUP_SIGNALS = Object.freeze(["SIGHUP", "SIGINT", "SIGTERM"]);
const TEMPORARY_ROOT_ENV = "SENNEL_TEST_TEMP_ROOT";

/** Prompt and concurrent batch errors preserve the underlying control failure. */
export function hasUnconfirmedExecution(error, visited = new Set()) {
  if (!(error instanceof Error) || visited.has(error)) return false;
  if (error instanceof ProcessExecutionControlFailure) return true;
  visited.add(error);
  return hasUnconfirmedExecution(error.cause, visited)
    || (error instanceof AggregateError && error.errors.some((cause) => hasUnconfirmedExecution(cause, visited)));
}

export class TestTemporaryRoot {
  #path;
  #remove;
  #removed = false;
  #owned;
  #pendingExecutions = 0;

  constructor(path, { remove = rmSync, owned = true } = {}) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("test temporary root path must be a non-empty string");
    }
    this.#path = path;
    this.#remove = remove;
    this.#owned = owned;
  }

  static createOnRepository({
    repositoryRoot = TEST_CHECKOUT_ROOT,
    remove = null,
  } = {}) {
    const paths = new TemporaryPaths(repositoryRoot);
    const directory = paths.create(paths.tests(), "sennel-test-");
    return new TestTemporaryRoot(directory, { remove: remove ?? (() => paths.cleanup(directory)) });
  }

  static select({ repositoryRoot = TEST_CHECKOUT_ROOT, environment = process.env } = {}) {
    const borrowed = TestTemporaryRootPolicy.borrowedRoot({ repositoryRoot, environment });
    return borrowed === null
      ? TestTemporaryRoot.createOnRepository({ repositoryRoot })
      : new TestTemporaryRoot(borrowed, { owned: false });
  }

  get path() {
    return this.#path;
  }

  get owned() {
    return this.#owned;
  }

  get retained() {
    return existsSync(join(this.#path, ".unconfirmed-execution"));
  }

  beginExecution() { this.#pendingExecutions += 1; }

  completeExecution() {
    if (this.#pendingExecutions === 0) throw new Error("No pending test execution to complete");
    this.#pendingExecutions -= 1;
  }

  retainOnUnconfirmedExecution(error) {
    if (arguments.length > 0 && !hasUnconfirmedExecution(error)) return false;
    // Borrowers publish this marker to the owning runner. Unknown child exit
    // must preserve both the fixture evidence and its coordinator authority.
    writeFileSync(join(this.#path, ".unconfirmed-execution"), "Execution completion is unconfirmed. Preserve this root for diagnosis.\n", { flag: "a" });
    return true;
  }

  activate({
    environment = process.env,
    processEvents = process,
    terminate = (signal) => process.kill(process.pid, signal),
  } = {}) {
    const names = ["TMPDIR", "TMP", "TEMP", TEMPORARY_ROOT_ENV, "GIT_CEILING_DIRECTORIES"];
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

    for (const name of ["TMPDIR", "TMP", "TEMP"]) environment[name] = this.#path;
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
    if (this.#removed || !this.#owned || this.retained) return;
    if (this.#pendingExecutions > 0) {
      this.retainOnUnconfirmedExecution();
      return;
    }
    this.#remove(this.#path, { recursive: true, force: true });
    this.#removed = true;
  }
}
