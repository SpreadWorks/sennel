import { RealDirectoryAuthority } from "./real-directory-authority.js";

// Retain the caller's observed directory chain across enumeration, copy and
// archive extraction. RealDirectoryAuthority owns physical checks and creation.
export function retainPluginDirectory(directory, authorities, { create = false, creationMode = 0o777 } = {}) {
  const ancestor = RealDirectoryAuthority.closestAncestor(directory, authorities.values());
  const authority = ancestor.descendant(directory, { create, creationMode });
  for (let current = authority; !authorities.has(current.directory); current = current.parentAuthority) {
    authorities.set(current.directory, current);
  }
  return authority;
}
