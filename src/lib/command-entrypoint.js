import { fileURLToPath, pathToFileURL } from "node:url";

export class CommandEntrypoint {
  constructor({ modulePath, invocation }) {
    if (typeof modulePath !== "string" || modulePath.trim() === "") {
      throw new Error("command entrypoint modulePath is required");
    }
    if (!new Set(["main", "script"]).has(invocation)) {
      throw new Error(`invalid command entrypoint invocation: ${invocation}`);
    }
    this.moduleUrl = new URL(modulePath, import.meta.url);
    this.modulePath = fileURLToPath(this.moduleUrl);
    this.invocation = invocation;
    Object.freeze(this);
  }

  async execute(args) {
    process.argv = [process.argv[0], this.modulePath, ...args];
    const mod = await import(pathToFileURL(this.modulePath).href);
    if (this.invocation === "script") return;
    if (typeof mod.main !== "function") {
      throw new Error(`command module does not export main(): ${this.modulePath}`);
    }
    await mod.main();
  }
}


/** The public inherited wrapper's executable route, shared by bootstrap and help metadata. */
class PublicCommandEntrypoint extends CommandEntrypoint {
  constructor() { super({ modulePath: "../command.js", invocation: "main" }); }
  get commandName() { return "command"; }
  accepts(argv) {
    return argv[0] === this.commandName && !["--help", "-h"].includes(argv[1]);
  }
}

export const publicCommandEntrypoint = new PublicCommandEntrypoint();
