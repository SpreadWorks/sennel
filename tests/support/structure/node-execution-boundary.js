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
const nodeNoOperandOptions = new Set(["-v", "--version", "-h", "--help", "-c", "--check", "-i", "--interactive", "--watch", "--test"]);

function nodeEvalCandidate(args) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index] instanceof ExecutionArgument ? args[index].value : args[index];
    if (value === "--") return false;
    if (nodeInlineOptions.has(value) || /^--(?:eval|print)=/.test(value)) return true;
  }
  return false;
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
        continue;
      }
      if (["--require", "--import"].some((option) => value.startsWith(`${option}=`))) continue;
      if (nodeNoOperandOptions.has(value)) continue;
      if (/^-[ep].+/.test(value)) continue;
      if (value.startsWith("-")) return nodeEvalCandidate(args.slice(index + 1))
        ? new NodeExecutionBoundary("incomplete", value) : new NodeExecutionBoundary("script");
      return new NodeExecutionBoundary("script");
    }
    return new NodeExecutionBoundary("script");
  }
}
