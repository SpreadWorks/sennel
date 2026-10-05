/**
 * src/lib/command.js
 *
 * Unified Command base class. Every CLI subcommand (flow / docs / check /
 * metrics) extends this class so the common dispatcher (src/lib/dispatcher.js)
 * can invoke them through a single contract.
 *
 *   class MyCmd extends Command {
 *     static outputMode = "envelope"; // or "raw"
 *     execute(ctx) { ... }
 *   }
 *
 * The dispatcher calls `run(container, input)`. The base `run()` stores the
 * container, assembles a context via `buildContext(input)` (subclasses may
 * override), and delegates to `execute(ctx)`.
 */

const VALID_OUTPUT_MODES = new Set(["envelope", "raw"]);

export class Command {
  /**
   * Output mode declaration. Dispatcher uses this to choose between
   * JSON-envelope wrapping or raw stdout passthrough.
   * Subclasses MUST override with "envelope" or "raw".
   * @type {"envelope"|"raw"}
   */
  static outputMode = "raw";

  /**
   * Validate a Command subclass's metadata. Throws if outputMode is invalid.
   * Invoked by the dispatcher at registration/dispatch time.
   */
  static validate(CommandClass) {
    const mode = CommandClass.outputMode;
    if (!VALID_OUTPUT_MODES.has(mode)) {
      throw new Error(
        `Command.validate: outputMode must be "envelope" or "raw", got: ${JSON.stringify(mode)}`,
      );
    }
  }

  /**
   * Entry point invoked by the dispatcher. Subclasses should NOT override
   * this; override `buildContext()` or `execute()` instead.
   *
   * @param {import("./container.js").Container} container
   * @param {Object} [input={}]
   * @returns {Promise<unknown>}
   */
  async run(container, input = {}) {
    this.container = container;
    const ctx = await this.buildContext(input);
    return this.execute(ctx);
  }

  /**
   * Build the ctx object passed to execute(). Default implementation
   * spreads the parsed input and exposes `container` as a reference.
   * Subclasses override to inject domain-specific resolved fields
   * (e.g. FlowCommand injects flowState/root/config).
   */
  buildContext(input) {
    return { container: this.container, ...input };
  }

  /**
   * Command logic. MUST be implemented by subclasses.
   * @throws {Error}
   */
  // eslint-disable-next-line no-unused-vars
  execute(ctx) {
    throw new Error("Command.execute() must be implemented by subclass");
  }
}
