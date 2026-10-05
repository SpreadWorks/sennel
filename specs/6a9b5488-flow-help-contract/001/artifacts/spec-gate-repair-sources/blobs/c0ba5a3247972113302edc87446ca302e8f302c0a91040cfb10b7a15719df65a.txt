import path from "node:path";
import { PKG_DIR } from "../../lib/cli.js";
import { PRODUCT } from "../../lib/product.js";

const LOADER_PATH = path.join(PKG_DIR, "flow", "lib", "execution-root-module-loader.js");

function absoluteDirectory(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute directory`);
  }
  return path.resolve(value);
}

export class SharedSpecTestExecution {
  constructor({ repositoryRoot, executionRoot, specRoot, canonicalSpecRoot = specRoot }) {
    this.repositoryRoot = absoluteDirectory(repositoryRoot, "repository root");
    this.executionRoot = absoluteDirectory(executionRoot, "execution root");
    this.specRoot = absoluteDirectory(specRoot, "spec root");
    this.canonicalSpecRoot = absoluteDirectory(canonicalSpecRoot, "canonical spec root");
    Object.freeze(this);
  }

  nodeArgv(args) {
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("shared spec test arguments must be non-empty strings");
    }
    return [
      "node",
      ...(this.usesModuleRedirect ? ["--experimental-loader", LOADER_PATH] : []),
      ...args,
    ];
  }

  get environment() {
    if (!this.usesModuleRedirect) return {};
    return {
      [PRODUCT.env("TEST_REPOSITORY_ROOT")]: this.repositoryRoot,
      [PRODUCT.env("TEST_EXECUTION_ROOT")]: this.executionRoot,
      [PRODUCT.env("TEST_SPEC_ROOT")]: this.specRoot,
      [PRODUCT.env("TEST_CANONICAL_SPEC_ROOT")]: this.canonicalSpecRoot,
    };
  }

  get usesModuleRedirect() {
    return this.repositoryRoot !== this.executionRoot || this.specRoot !== this.canonicalSpecRoot;
  }
}
