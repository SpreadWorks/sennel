import { FinalizeCommitInput } from "./finalize-commit-input.js";
import { FinalizationSettlementWriter } from "./finalization-settlement-writer.js";
import { FinalizationStepService } from "./finalization-step-service.js";

export class FinalizeCommitService extends FinalizationStepService {
  static argumentTypes = [FinalizeCommitInput, FinalizationSettlementWriter];
  get settlementOutcome() { return super.settlementOutcome; }
  constructor(input, writer) {
    if (!(input instanceof FinalizeCommitInput) || !(writer instanceof FinalizationSettlementWriter)) {
      throw new TypeError("FinalizeCommitService requires typed input and a save-only writer");
    }
    super(input, writer);
  }
}
