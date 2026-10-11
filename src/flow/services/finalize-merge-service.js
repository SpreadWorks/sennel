import { FinalizeMergeInput } from "./finalize-merge-input.js";
import { FinalizationSettlementWriter } from "./finalization-settlement-writer.js";
import { FinalizationStepService } from "./finalization-step-service.js";

export class FinalizeMergeService extends FinalizationStepService {
  static argumentTypes = [FinalizeMergeInput, FinalizationSettlementWriter];
  get settlementOutcome() { return super.settlementOutcome; }
  constructor(input, writer) {
    if (!(input instanceof FinalizeMergeInput) || !(writer instanceof FinalizationSettlementWriter)) {
      throw new TypeError("FinalizeMergeService requires typed input and a save-only writer");
    }
    super(input, writer);
  }
}
