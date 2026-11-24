import { FileIdentity } from "./file-identity.js";

/** A retained producer's integer tokens, distinct from current native authority.
 * Numeric tokens occur only in an explicitly migrated evidence version. Their
 * semantic identities are exact decimal integers; their original proof bytes
 * remain available so migration never fabricates a new exit acknowledgement.
 */
export class ProcessCheckoutEvidenceEncoding {
  #value;
  constructor(value, { previous = false } = {}) {
    const names = ["mainDevice", "mainInode", "checkoutDevice", "checkoutInode"];
    const retained = names.every((name) => Number.isSafeInteger(value[name]) && value[name] >= 0 && !Object.is(value[name], -0));
    if (previous && !retained) throw new TypeError("Previous checkout evidence requires exact original numeric integers");
    const decimals = Object.fromEntries(names.map((name) => [name, retained ? value[name].toString() : value[name]]));
    FileIdentity.fromStored({ dev: decimals.mainDevice, ino: decimals.mainInode });
    FileIdentity.fromStored({ dev: decimals.checkoutDevice, ino: decimals.checkoutInode });
    this.retained = retained;
    this.decimals = Object.freeze({ mainRoot: value.mainRoot, executionRoot: value.executionRoot, ...decimals });
    this.#value = Object.freeze({ mainRoot: value.mainRoot, executionRoot: value.executionRoot,
      ...Object.fromEntries(names.map((name) => [name, value[name]])) });
    if (Object.keys(value).length !== 6 || Object.keys(this.#value).some((key) => !Object.hasOwn(value, key))) throw new TypeError("Checkout evidence has unknown or missing fields");
    Object.freeze(this);
  }
  toJSON() { return { ...this.#value }; }
}
