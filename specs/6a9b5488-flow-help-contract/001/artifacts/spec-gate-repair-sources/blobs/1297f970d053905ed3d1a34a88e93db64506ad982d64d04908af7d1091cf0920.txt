/**
 * Canonical identity for the product-owned namespaces.
 *
 * Keep product naming here so persisted paths, environment variables,
 * protocol markers, and public integration names cannot silently drift.
 */
export class ProductIdentity {
  constructor({ displayName, machineName, packageName, repository, entrypoint }) {
    for (const [name, value] of Object.entries({ displayName, machineName, packageName, repository, entrypoint })) {
      if (typeof value !== "string" || value.trim() === "") throw new TypeError(`ProductIdentity.${name} must be a non-empty string`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(machineName)) throw new TypeError("ProductIdentity.machineName must be a lowercase package identifier");
    if (!/^[a-z][a-z0-9-]*$/.test(packageName)) throw new TypeError("ProductIdentity.packageName must be a lowercase package identifier");
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new TypeError("ProductIdentity.repository must be an owner/repository pair");
    if (!entrypoint.startsWith("src/")) throw new TypeError("ProductIdentity.entrypoint must be a src/ path");

    this.displayName = displayName;
    this.machineName = machineName;
    this.packageName = packageName;
    this.repository = repository;
    this.repositoryOwner = repository.split("/")[0];
    this.entrypoint = entrypoint;
    this.entrypointBasename = entrypoint.split("/").at(-1);
    this.managedDirName = `.${machineName}`;
    this.envPrefix = `${machineName.toUpperCase()}_`;
    this.skillNamespace = `${machineName}.`;
    this.repositoryUrl = this.githubUrl(repository);
    this.officialPresetsRepository = this.officialRepository("presets");
    this.workflowPluginRepository = this.officialRepository("workflow-plugin");
    this.officialPresetsRepositoryUrl = this.githubUrl(this.officialPresetsRepository);
    this.workflowPluginRepositoryUrl = this.githubUrl(this.workflowPluginRepository);
    Object.freeze(this);
  }

  env(name) {
    return `${this.envPrefix}${name}`;
  }

  managedPath(...segments) {
    return [this.managedDirName, ...segments].join("/");
  }

  skill(name) {
    return `${this.skillNamespace}${name}`;
  }

  artifactMarker(name) {
    return `${this.machineName}-${name}`;
  }

  protocol(name, version = null) {
    return [this.machineName, name, version].filter(Boolean).join("-");
  }

  provider(name) {
    return this.artifactMarker(name);
  }

  hashSalt(name, version) {
    return `${this.protocol(name, version)}\0`;
  }

  temporaryPrefix(name) {
    return `${this.artifactMarker(name)}-`;
  }

  flowBaselineRef(runId) {
    return `refs/${this.machineName}/flows/${runId}/baseline`;
  }

  officialRepository(name) {
    return `${this.repositoryOwner}/${this.machineName}-${name}`;
  }

  githubUrl(repository) {
    return `https://github.com/${repository}.git`;
  }
}

export const PRODUCT = new ProductIdentity({
  displayName: "Sennel",
  machineName: "sennel",
  packageName: "sennel",
  repository: "SpreadWorks/sennel",
  entrypoint: "src/sennel.js",
});
