import { FinalizeCleanupInput } from "./finalize-cleanup-input.js";
import { FinalizationSettlementWriter } from "./finalization-settlement-writer.js";
import { FinalizationStepService } from "./finalization-step-service.js";

export class FinalizeCleanupService extends FinalizationStepService {
  static argumentTypes = [FinalizeCleanupInput, FinalizationSettlementWriter];
  get settlementOutcome() { return super.settlementOutcome; }
  constructor(input, writer) {
    if (!(input instanceof FinalizeCleanupInput) || !(writer instanceof FinalizationSettlementWriter)) {
      throw new TypeError("FinalizeCleanupService requires typed input and a save-only writer");
    }
    super(input, writer);
  }
}
