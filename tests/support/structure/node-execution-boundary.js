export class ExecutionArgument {
  constructor(value, unresolved) {
    if (typeof value !== "string" || typeof unresolved !== "boolean") throw new TypeError("execution argument required");
    this.value = value;
    this.unresolved = unresolved;
    Object.freeze(this);
  }
}

const nodeInlineOptions = new Set(["-e", "-p", "-pe", "-ep", "--eval", "--print"]);
const nodeLoaderOptions = new Set(["-r", "--require", "--import"]);
const nodeNoOperandOptions = new Set(["-v", "--version", "-h", "--help", "-c", "--check", "-i", "--interactive", "--watch", "--test", "--no-warnings"]);

function inlineModule(specifier) {
  // The URL scheme establishes an inline module, regardless of its MIME type,
  // encoding or contents. Never decode or execute its payload to classify it.
  try { return new URL(specifier).protocol === "data:"; }
  catch { return false; } // Ordinary preload paths are not absolute URLs.
}

/** The Node CLI authority ends at its first script operand or explicit `--`. */
export class NodeExecutionBoundary {
  constructor(status, option = null) {
    if (!["script", "inline", "incomplete"].includes(status)) throw new TypeError("Node execution boundary status required");
    this.status = status;
    this.option = option;
    Object.freeze(this);
  }

  static inspect(executable, args) {
    const name = executable.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
    if (name !== "node" && name !== "node.exe") return null;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index] instanceof ExecutionArgument ? args[index] : new ExecutionArgument(args[index], false);
      const value = argument.value;
      if (argument.unresolved) return new NodeExecutionBoundary("incomplete", value);
      if (value === "--") return new NodeExecutionBoundary("script");
      if (nodeInlineOptions.has(value) || /^--(?:eval|print)=/.test(value)) {
        return new NodeExecutionBoundary("inline", value);
      }
      if (nodeLoaderOptions.has(value)) {
        if (index + 1 >= args.length) return new NodeExecutionBoundary("incomplete", value);
        const operand = args[++index] instanceof ExecutionArgument ? args[index] : new ExecutionArgument(args[index], false);
        if (operand.unresolved) return new NodeExecutionBoundary("incomplete", value);
        if (value === "--import" && inlineModule(operand.value)) return new NodeExecutionBoundary("inline", value);
        continue;
      }
      if (value.startsWith("--import=")) {
        if (inlineModule(value.slice("--import=".length))) return new NodeExecutionBoundary("inline", "--import");
        continue;
      }
      if (value.startsWith("--require=")) continue;
      if (nodeNoOperandOptions.has(value)) continue;
      if (value.startsWith("-")) return new NodeExecutionBoundary("incomplete", value);
      return new NodeExecutionBoundary("script");
    }
    return new NodeExecutionBoundary("script");
  }
}
