import { TestTemporaryRoot } from "./test-temporary-root.js";

let temporaryRoot;

/** Direct test runs own a root; runner children borrow their parent's root. */
export function testTemporaryRoot() {
  if (temporaryRoot === undefined) {
    temporaryRoot = TestTemporaryRoot.select();
    temporaryRoot.activate();
  }
  return temporaryRoot;
}
