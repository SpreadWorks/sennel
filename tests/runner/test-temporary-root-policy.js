import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TemporaryPaths } from "../../src/lib/temporary-paths.js";
import { isNativePathWithin } from "../../src/lib/portable-path.js";

export const TEST_CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Selection policy; allocation and fixture lifetime belong to test support. */
export class TestTemporaryRootPolicy {
  static borrowedRoot({ repositoryRoot, environment }) {
    const selected = environment.SENNEL_TEST_TEMP_ROOT;
    if (selected === undefined) return null;
    const paths = new TemporaryPaths(repositoryRoot);
    const canonical = realpathSync(paths.validate(selected));
    if (canonical !== resolve(selected)) throw new Error("shared test temporary root must be canonical");
    if (canonical === paths.tests() || !isNativePathWithin(paths.tests(), canonical)) {
      const error = new Error("shared test temporary root must stay inside project test storage");
      error.code = "TEST_TEMPORARY_ROOT_OUTSIDE_TESTS";
      throw error;
    }
    accessSync(canonical, constants.W_OK | constants.X_OK);
    return canonical;
  }
}
