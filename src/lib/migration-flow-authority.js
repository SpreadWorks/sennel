import fs from "node:fs";
import path from "node:path";

import { ActiveFlowRegistry } from "./active-flow-registry.js";
import { CanonicalFlowManagerStore } from "../flow/lib/canonical-flow-manager-store.js";
import { FlowSpecId } from "./flow-spec-id.js";
import { FlowTargetIdentity, FlowTargetIdentityAuthority } from "./flow-target-identity-authority.js";
import { FlowId, FlowVersion, FlowVersionId } from "./flow-version.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { WorktreeFlowBindingStore, WORKTREE_FLOW_BINDING_FILE } from "./worktree-flow-binding.js";

export class MigrationFlowAuthorityError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "MigrationFlowAuthorityError";
    this.code = code;
  }
}

/** Proven native Flow identity, independent of its historical Artifact schema. */
export class MigrationFlowIdentity {
  constructor(state, specRoot, version = 1) {
    this.state = state;
    this.target = FlowTargetIdentity.active(state, state.execution.mode, specRoot);
    this.flowId = FlowId.from(state.flowId).toString();
    this.flowVersionId = FlowVersionId.from(state.flowVersionId).toString();
    this.runId = this.target.runId;
    this.specId = this.target.specId;
    this.version = new FlowVersion(version).value;
    Object.freeze(this);
  }

}

/** Identity references from an unrelated source, without accepting its schema. */
class MigrationFlowClaim {
  constructor(state, specId, version) {
    this.flowId = state.flowId;
    this.flowVersionId = state.flowVersionId;
    this.runId = state.runId;
    this.specId = specId;
    this.version = version;
    Object.freeze(this);
  }
}

/** Two representatives suffice for self and selected-Spec exclusion. */
class MigrationFlowClaimGroup {
  constructor(first) {
    this.first = first;
    this.second = null;
    this.otherSpec = null;
  }

  add(claim) {
    this.second ??= claim;
    if (claim.specId !== this.first.specId) this.otherSpec ??= claim;
  }

  otherThan(claim, excludeSpecId) {
    if (excludeSpecId !== undefined) {
      return this.first.specId !== excludeSpecId ? this.first : this.otherSpec;
    }
    return this.first !== claim ? this.first : this.second;
  }

  otherSpecThan(specId) {
    return this.first.specId !== specId ? this.first : this.otherSpec;
  }
}

/** One owner for collision rules; lookup never scans a collision bucket. */
export class MigrationFlowIdentityIndex {
  #flowIds = new Map();
  #tuples = new Map();
  #versionIds = new Map();
  #runIds = new Map();

  constructor(claims) {
    for (const claim of claims) {
      this.#add(this.#flowIds, claim.flowId, claim);
      let versions = this.#tuples.get(claim.flowId);
      if (!versions) this.#tuples.set(claim.flowId, versions = new Map());
      this.#add(versions, claim.version, claim);
      this.#add(this.#versionIds, claim.flowVersionId, claim);
      this.#add(this.#runIds, claim.runId, claim);
    }
  }

  #add(groups, key, claim) {
    const group = groups.get(key);
    if (group) group.add(claim);
    else groups.set(key, new MigrationFlowClaimGroup(claim));
  }

  collisionsFor(identity, { excludeSpecId } = {}) {
    const collisions = [];
    if (this.#flowIds.get(identity.flowId)?.otherSpecThan(identity.specId)) {
      collisions.push(new MigrationFlowAuthorityError("FLOW_ID_CROSS_SPEC_COLLISION", `flowId is shared across spec identities: ${identity.flowId}`));
    }
    if (this.#tuples.get(identity.flowId)?.get(identity.version)?.otherThan(identity, excludeSpecId)) {
      collisions.push(new MigrationFlowAuthorityError("FLOW_VERSION_TUPLE_COLLISION", `flowId and Version pair is already materialized: ${identity.flowId}@${identity.version}`));
    }
    if (this.#versionIds.get(identity.flowVersionId)?.otherThan(identity, excludeSpecId)) {
      collisions.push(new MigrationFlowAuthorityError("FLOW_VERSION_ID_COLLISION", `flowVersionId is already claimed: ${identity.flowVersionId}`));
    }
    if (this.#runIds.get(identity.runId)?.otherThan(identity, excludeSpecId)) {
      collisions.push(new MigrationFlowAuthorityError("RUN_ID_COLLISION", `runId is already claimed: ${identity.runId}`));
    }
    return collisions;
  }
}

/** Read-only authority evidence checked before an offline migration writes. */
export class MigrationFlowAuthoritySnapshot {
  constructor({ identities, evidence }) {
    this.identities = Object.freeze([...identities]);
    this.targetIdentities = evidence.targetIdentities;
    this.activeEntries = evidence.activeEntries;
    Object.freeze(this);
  }
}

/** Repository-wide evidence is prepared once, including immutable projections. */
class MigrationFlowRepositoryEvidence {
  constructor({ targetIdentities, activeEntries, claims }) {
    this.targetIdentities = targetIdentities;
    this.activeEntries = Object.freeze(activeEntries.map((entry) => Object.freeze(entry)));
    this.targetsBySpec = new Map(targetIdentities.entries.map((entry) => [entry.specId, entry]));
    this.targetsByRun = new Map(targetIdentities.entries.map((entry) => [entry.runId, entry]));
    this.activeBySpec = new Map(this.activeEntries.map((entry) => [entry.specId, entry]));
    this.claims = new MigrationFlowIdentityIndex(claims);
    Object.freeze(this);
  }
}

function readFlowClaims(specRoot, inspect) {
  const directory = path.join(specRoot.root, ...specRoot.relativePath.split("/"));
  if (!fs.existsSync(directory)) return;
  new RealDirectoryAuthority(directory).assertStable();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { FlowSpecId.from(entry.name); } catch { continue; }
    const candidateRoot = path.join(directory, entry.name);
    const paths = [[path.join(candidateRoot, "flow.json"), 1]];
    for (const version of fs.readdirSync(candidateRoot, { withFileTypes: true })) {
      if (version.isDirectory() && !version.isSymbolicLink() && /^[0-9]+$/.test(version.name)) {
        paths.push([path.join(candidateRoot, version.name, "flow.json"), Number(version.name)]);
      }
    }
    for (const [file, version] of paths) {
      let state;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
        state = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch { continue; }
      if (state === null || typeof state !== "object" || Array.isArray(state)) continue;
      // Only identity references are observed. An unrelated version's schema,
      // ledger and catalog are not migration input for this selection.
      inspect(new MigrationFlowClaim(state, entry.name, version));
    }
  }
}

/** Point-in-time, read-only evidence for one runner's preflight only.
 * Publication, recovery and runtime diagnostics always use the fresh API below.
 * This snapshot does not grant authority to publish or replace source checks. */
export class MigrationFlowAuthorityPreflight {
  #evidence = null;
  #failure = null;

  constructor({ root, specRoot }) {
    this.root = path.resolve(root);
    this.relativePath = typeof specRoot === "string" ? specRoot : specRoot.relativePath;
    Object.freeze(this);
  }

  #read() {
    if (this.#failure) throw this.#failure;
    if (this.#evidence) return this.#evidence;
    try {
      const targetIdentities = FlowTargetIdentityAuthority.readSnapshot(this.root);
      let activeEntries;
      try { activeEntries = ActiveFlowRegistry.readEntries(this.root); }
      catch (cause) {
        throw new MigrationFlowAuthorityError(cause.code ?? "ACTIVE_FLOW_REGISTRY_CORRUPT", cause.message, { cause });
      }
      const claims = [];
      readFlowClaims({ root: this.root, relativePath: this.relativePath }, (claim) => claims.push(claim));
      this.#evidence = new MigrationFlowRepositoryEvidence({ targetIdentities, activeEntries, claims });
      return this.#evidence;
    } catch (cause) {
      this.#failure = cause;
      throw cause;
    }
  }

  assert({ specId, states, versions = states.map(() => 1), currentState = states[0] ?? null }) {
    const selected = FlowSpecId.from(specId).toString();
    const relativePath = this.relativePath;
    const root = this.root;
    const identities = states.map((state, index) => new MigrationFlowIdentity(state, relativePath, Number(versions[index])));
    const evidence = this.#read();
    const { targetsBySpec, targetsByRun, activeBySpec, claims } = evidence;
    const registryEntry = activeBySpec.get(selected);
    const specClaim = targetsBySpec.get(selected);
    if (registryEntry || specClaim) {
      if (!registryEntry || !specClaim) {
        throw new MigrationFlowAuthorityError("FLOW_TARGET_AUTHORITY_CORRUPT",
          `selected Flow requires both active registry and target identity authority: ${selected}`);
      }
      if (currentState === null) {
        throw new MigrationFlowAuthorityError("FLOW_TARGET_AUTHORITY_CORRUPT",
          `selected active Flow has no proven canonical Version 001: ${selected}`);
      }
    }
    const selectedIndex = new MigrationFlowIdentityIndex(identities);
    for (const identity of identities) {
      if (identity.specId !== selected) {
        throw new MigrationFlowAuthorityError("VERSION_IDENTITY_MISMATCH", "migration state identity differs from its selected spec");
      }
      const [collision] = selectedIndex.collisionsFor(identity);
      if (collision) throw collision;
      const runClaim = targetsByRun.get(identity.runId);
      if (runClaim && runClaim.specId !== selected) {
        throw new MigrationFlowAuthorityError("RUN_ID_COLLISION", `target identity authority claims runId for another Flow: ${identity.runId}`);
      }
      // Repository authorities select the active Version. Historical inactive
      // Versions may coexist, but may not reuse another target's concrete run.
      if (identity.state === currentState && specClaim) specClaim.assertState(identity.state, { specRoot: relativePath });
      if (identity.state === currentState && registryEntry) {
        if (!specClaim || specClaim.runId !== identity.runId) {
          throw new MigrationFlowAuthorityError("FLOW_TARGET_AUTHORITY_CORRUPT", "active registry and migration target identity authority disagree");
        }
        if (registryEntry.mode !== identity.state.execution.mode) {
          throw new MigrationFlowAuthorityError("ACTIVE_FLOW_REGISTRY_MODE_CONFLICT", "active registry and migration target execution mode disagree");
        }
      }
      if (identity.state === currentState && identity.state.execution.mode === "worktree") {
        const worktreePath = CanonicalFlowManagerStore.resolveWorktreePaths({ root, mainRoot: root, state: identity.state }).worktreePath;
        const bindingPath = path.join(worktreePath, WORKTREE_FLOW_BINDING_FILE);
        let bindingExists;
        try { fs.lstatSync(bindingPath); bindingExists = true; }
        catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
          bindingExists = false;
        }
        if (bindingExists) {
          try {
            new WorktreeFlowBindingStore({ worktreePath }).loadOwned().identity.assertFlowState(identity.state);
          } catch (cause) {
            throw new MigrationFlowAuthorityError("WORKTREE_FLOW_BINDING_CORRUPT", cause.message, { cause });
          }
        } else if (registryEntry?.mode === "worktree") {
          throw new MigrationFlowAuthorityError("WORKTREE_FLOW_BINDING_CORRUPT", `active migration target worktree binding is missing: ${bindingPath}`);
        }
      }
    }
    for (const identity of identities) {
      const [collision] = claims.collisionsFor(identity, { excludeSpecId: selected });
      if (collision) throw collision;
    }
    return new MigrationFlowAuthoritySnapshot({ identities, evidence });
  }
}

/** Fresh native authority reads; never registers, repairs or locks a Flow. */
export function assertMigrationFlowAuthority(options) {
  return new MigrationFlowAuthorityPreflight(options).assert(options);
}
