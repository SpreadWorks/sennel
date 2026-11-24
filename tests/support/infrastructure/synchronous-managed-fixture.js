import { closeSynchronousExecutionBridge } from "../../../src/lib/process-execution-sync.js";
import { createTmpDir } from "../builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "./runtime-fixture-cleanup.js";
import { testTemporaryRoot } from "../../test-environment.js";

let unexpectedFailure = null;

/** A fixture is removable only after its synchronous scopes and assertions finish. */
export class SynchronousManagedFixture {
  constructor(t, prefix) {
    if (unexpectedFailure !== null) throw new Error("An earlier synchronous scope fixture is retained", { cause: unexpectedFailure });
    this.root = createTmpDir(prefix);
    this.complete = false;
    t.after(() => {
      if (!this.complete) {
        unexpectedFailure ??= new Error("Synchronous managed scope did not complete its assertions");
        process.removeListener("beforeExit", closeSynchronousExecutionBridge);
        testTemporaryRoot().retainOnUnconfirmedExecution();
        return;
      }
      closeSynchronousExecutionBridge();
      removeQuiescentRuntimeFixture({ mainRoot: this.root });
    });
  }
}
