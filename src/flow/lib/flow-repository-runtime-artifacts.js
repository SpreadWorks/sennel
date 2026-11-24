import path from "node:path";

import { FlowTargetIdentityAuthority } from "../../lib/flow-target-identity-authority.js";
import { FlowVersionRuntimeLockLocation } from "../../lib/flow-version.js";
import { PRODUCT } from "../../lib/product.js";

function normalizedRepositoryPath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\")) {
    throw new Error("repository runtime artifact path must be a repository-relative POSIX path");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error("repository runtime artifact path must stay inside the repository");
  }
  return normalized;
}

/**
 * Repository-level Sennel runtime artifacts are owned by the CLI process, not
 * by a Flow worker. They must not contribute to implementation fingerprints or
 * worker mutation authority, while Version-owned artifacts remain observable.
 */
export class FlowRepositoryRuntimeArtifactRegistry {
  #exact;
  #prefixes;

  constructor() {
    this.#exact = new Set([
      PRODUCT.managedPath(".active-flow"),
      ...FlowTargetIdentityAuthority.repositoryPaths(),
      PRODUCT.managedPath(".worktree-prepare-attempt.json"),
      PRODUCT.managedPath("flow-identity.json"),
      PRODUCT.managedPath(".flow-identity.publication.json"),
      PRODUCT.managedPath(".flow-identity.publication.intent"),
      PRODUCT.managedPath(".flow-identity.publication.receipt.tmp"),
      PRODUCT.managedPath(".flow-identity.publication.binding.tmp"),
      PRODUCT.managedPath("last-finalized-spec"),
    ]);
    this.#prefixes = Object.freeze([
      ".tmp/",
      `${PRODUCT.managedPath(".active-flow")}.`,
      `${PRODUCT.managedPath("agent-cache")}/`,
      `${PRODUCT.managedPath("agent-work")}/`,
      `${PRODUCT.managedPath("process-runtime")}/`,
      `${PRODUCT.managedPath("output")}/`,
      `${PRODUCT.managedPath("recovery")}/`,
      `${PRODUCT.managedPath("worktree")}/`,
    ]);
    Object.freeze(this);
  }

  owns(value, { runtimeLocks = [] } = {}) {
    const relativePath = normalizedRepositoryPath(value);
    if (!Array.isArray(runtimeLocks) || runtimeLocks.some((lock) => !(lock instanceof FlowVersionRuntimeLockLocation))) {
      throw new Error("repository runtime lock ownership requires FlowVersionRuntimeLockLocation values");
    }
    return this.#exact.has(relativePath)
      || (relativePath.endsWith(".tmp") && [...this.#exact].some((owned) => (
        relativePath.startsWith(`${owned}.`) && relativePath.slice(owned.length + 1).endsWith(".tmp")
          && !relativePath.slice(owned.length + 1).includes("/")
      )))
      || this.#prefixes.some((prefix) => relativePath.startsWith(prefix))
      || runtimeLocks.some((lock) => lock.matchesRepositoryPath(relativePath));
  }

  gitPathspecExcludes({ relativeToCwd = false } = {}) {
    const anchor = relativeToCwd ? "" : ",top";
    return Object.freeze([
      ...[...this.#exact].flatMap((owned) => [
        `:(exclude${anchor},literal)${owned}`,
        `:(exclude${anchor},glob)${owned}.*.tmp`,
      ]),
      ...this.#prefixes.map((prefix) => `:(exclude${anchor},glob)${prefix}**`),
    ]);
  }

  /** Directory ownership shared by source and Task Review snapshots. */
  directoryRoots() {
    return Object.freeze(this.#prefixes.filter((prefix) => prefix.endsWith("/"))
      .map((prefix) => prefix.slice(0, -1)));
  }
}
