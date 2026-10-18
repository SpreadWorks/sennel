// Executable identity policy is shared by source calls and public instructions.
// Command arguments and shell grammar belong to their respective consumers.
const osExecutables = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "csh", "fish", "cmd", "powershell", "pwsh",
  "sudo", "doas", "env", "ps", "pgrep", "pkill", "kill", "killall", "taskkill", "tasklist", "wmic",
  "chmod", "chown", "chgrp", "stat", "mount", "umount", "findmnt", "readlink", "realpath", "which", "where",
  "ls", "cat", "cp", "mv", "rm", "rmdir", "mkdir", "mktemp", "touch", "ln", "find", "install",
  "grep", "sed", "awk", "xargs", "tee", "head", "tail", "cut", "sort", "uniq", "wc", "tr",
  "timeout", "setsid", "nohup", "uname", "id", "whoami", "getconf", "ulimit", "export", "source", "trap",
]);
const portableExecutables = new Set(["node", "git", "gh"]);
const portableShellCommands = new Set(["npm", "npx", "pnpm", "yarn", "corepack", "sennel"]);

class ExecutableClassification {
  constructor(executable, identity) {
    if (typeof executable !== "string" || !executable || executable.includes("\0") || typeof identity !== "string" || !identity) throw new TypeError("literal executable identity required");
    this.executable = executable;
    this.identity = identity;
    Object.freeze(this);
  }
}
export class PortableExecutable extends ExecutableClassification {}
export class OsSpecificExecutable extends ExecutableClassification {}
export class UnclassifiedExecutable extends ExecutableClassification {}

export function classifyExecutable(executable, { representation = "native" } = {}) {
  if (!["native", "instruction"].includes(representation)) throw new TypeError("executable boundary representation required");
  const name = executable.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  if (osExecutables.has(name) || /\.(?:exe|cmd|bat|ps1|sh)$/.test(name)
    || /^\/(?:usr|bin|sbin|opt|Applications|System|Windows)(?:\/|$)/.test(executable)
    || /^[A-Za-z]:[\\/]/.test(executable)) return new OsSpecificExecutable(executable, name);
  if (portableExecutables.has(executable) || representation === "instruction" && portableShellCommands.has(executable)) return new PortableExecutable(executable, name);
  return new UnclassifiedExecutable(executable, name);
}
