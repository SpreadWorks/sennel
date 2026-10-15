/** One immutable command value for Definition execution and recovery directives. */
export class FlowExecutionCommand {
  constructor({ group, subcommand, args = [] } = {}) {
    if (group !== "run" && group !== "set") throw new Error("flow execution command group must be run or set");
    if (typeof subcommand !== "string" || subcommand === "" || /[\s\0]/.test(subcommand)) {
      throw new Error("flow execution command subcommand must be a non-empty command token");
    }
    if (!Array.isArray(args) || [...args].some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("flow execution command args must be NUL-free strings");
    }
    this.group = group;
    this.subcommand = subcommand;
    this.args = Object.freeze([...args]);
    Object.freeze(this);
  }

  toString() {
    const displayToken = (token) => /^[a-zA-Z0-9_./:=+-]+$/.test(token)
      ? token : `'${token.replaceAll("'", "'\"'\"'")}'`;
    return ["sennel", "flow", this.group, this.subcommand, ...this.args].map(displayToken).join(" ");
  }

  runArguments() { return [this.subcommand, ...this.args]; }

  bindTarget(binding) {
    return new FlowExecutionCommand({ group: this.group, subcommand: this.subcommand,
      args: [...this.args, ...binding.guardArguments()] });
  }

  toJSON() { return { group: this.group, subcommand: this.subcommand, args: [...this.args] }; }

  static fromStored(value) {
    if (value instanceof FlowExecutionCommand) return value;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "args,group,subcommand") {
      throw new Error("stored flow execution command must contain group, subcommand and args");
    }
    return new FlowExecutionCommand(value);
  }
}
