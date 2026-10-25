import { withManagedProcessScope } from "../../../src/lib/managed-process.js";
import { testTemporaryRoot } from "../../test-environment.js";

/** Keep the actual scope live through projection/calls and preserve uncertain resources. */
export async function withReadOnlyAgentControlScope(root, callback, owner = testTemporaryRoot()) {
  try { return await withManagedProcessScope({ executionRoot: root }, callback); }
  catch (error) { owner.retainOnUnconfirmedExecution(error); throw error; }
}

/** Literal Codex policy for read-only research with only owned control scratch writable. */
export function readOnlyCodexProfile(profile) {
  const args = [...profile.args];
  const sandbox = args.indexOf("--sandbox");
  if (profile.command !== "codex" || sandbox < 0 || args[sandbox + 1] !== "read-only") {
    throw new TypeError("Read-only control profile requires an existing literal Codex read-only policy");
  }
  args.splice(sandbox, 2,
    "-c", 'default_permissions="sennel-control"',
    "-c", 'permissions.sennel-control.extends=":read-only"',
    "-c", 'permissions.sennel-control.filesystem={{{CONTROL_DIRECTORY_JSON}}="write"}',
    "-c", "permissions.sennel-control.network.enabled=false");
  return { ...profile, args };
}
