import path from "node:path";
import { fileURLToPath } from "node:url";

/** Original package authority; the fixed runtime never relocates source URLs. */
export class RuntimePackageLocation {
  constructor(root) {
    this.root = path.resolve(root);
    Object.freeze(this);
  }

  key(input) {
    const file = input instanceof URL ? fileURLToPath(input) : path.resolve(input);
    return path.relative(this.root, file).split(path.sep).join("/");
  }

  owns(input) {
    const key = this.key(input);
    return key === "package.json" || key === "src" || key.startsWith("src/");
  }
}
