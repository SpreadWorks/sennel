import fs from "node:fs";
import { FileLock, FileLockWaitPolicy } from "../../../src/lib/file-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";

const { directory, fileName, kind, authority, waitPolicy, readyPath } = JSON.parse(process.argv[2]);
const lock = new FileLock({ directoryAuthority: new RealDirectoryAuthority(directory),
  fileName, kind, authority, waitPolicy: new FileLockWaitPolicy(waitPolicy) });
process.stdin.once("data", () => { lock.release(); process.exit(0); });
lock.acquire();
fs.writeFileSync(readyPath, "ready");
