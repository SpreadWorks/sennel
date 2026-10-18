// Executable identity policy is shared by source calls and public instructions.
// Command arguments and shell grammar belong to their respective consumers.
const osExecutables = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "csh", "fish", "cmd", "powershell",
  "sudo", "doas", "env", "ps", "pgrep", "pkill", "kill", "killall", "taskkill", "tasklist", "wmic",
  "chmod", "chown", "chgrp", "stat", "mount", "umount", "findmnt", "readlink", "realpath", "which", "where",
  "ls", "cat", "cp", "mv", "rm", "rmdir", "mkdir", "mktemp", "touch", "ln", "find", "install",
  "grep", "sed", "awk", "xargs", "tee", "head", "tail", "cut", "sort", "uniq", "wc", "tr",
  "timeout", "setsid", "nohup", "uname", "id", "whoami", "getconf", "ulimit", "export", "source", "trap",
]);
const portableExecutables = new Set(["node", "git", "gh"]);
const portableShellCommands = new Set(["npm", "npx", "pnpm", "yarn", "corepack", "sennel"]);
export const supportedPlatforms = Object.freeze(["linux", "darwin", "win32"]);
const windowsCommands = new Set(["cmd", "powershell", "taskkill", "tasklist", "wmic", "where"]);

class ExecutableClassification {
  constructor(executable, identity, platforms = []) {
    if (typeof executable !== "string" || !executable || executable.includes("\0") || typeof identity !== "string" || !identity) throw new TypeError("literal executable identity required");
    this.executable = executable;
    this.identity = identity;
    this.platforms = Object.freeze([...platforms]);
    Object.freeze(this);
  }
}
export class PortableExecutable extends ExecutableClassification {}
export class OsSpecificExecutable extends ExecutableClassification {}
export class UnclassifiedExecutable extends ExecutableClassification {}

export function classifyExecutable(executable, { representation = "native" } = {}) {
  if (!["native", "instruction"].includes(representation)) throw new TypeError("executable boundary representation required");
  const name = executable.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  const identity = name.replace(/\.exe$/, "");
  const platforms = /^[A-Za-z]:[\\/]/.test(executable) || name.endsWith(".exe") ? ["win32"]
    : executable.startsWith("/") ? ["linux", "darwin"] : supportedPlatforms;
  if (portableExecutables.has(identity) || representation === "instruction" && portableShellCommands.has(executable)) return new PortableExecutable(executable, identity, platforms);
  if (osExecutables.has(identity)) {
    const available = windowsCommands.has(identity) ? ["win32"] : ["linux", "darwin"];
    return new OsSpecificExecutable(executable, identity, available.filter((platform) => platforms.includes(platform)));
  }
  // An extension alone establishes neither executable identity nor availability.
  return new UnclassifiedExecutable(executable, name);
}
