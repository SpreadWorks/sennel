import { mock } from "node:test";

const originalMethods = new WeakMap();

/** Override the external process dependency while retaining the public method. */
export function installCommandProcessFake(Command, runCommand, method = "execute") {
  const current = Command.prototype[method];
  const execute = originalMethods.get(current) ?? current;
  const replacement = mock.method(Command.prototype, method, async function (...args) {
    const originalRunCommand = this.runCommand;
    this.runCommand = runCommand;
    try { return await execute.apply(this, args); }
    finally { this.runCommand = originalRunCommand; }
  });
  originalMethods.set(replacement, execute);
  return replacement;
}
