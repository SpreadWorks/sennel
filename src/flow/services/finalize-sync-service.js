import { FinalizeSyncInput } from "./finalize-sync-input.js";
import { FinalizationSettlementWriter } from "./finalization-settlement-writer.js";
import { FinalizationStepService } from "./finalization-step-service.js";

export class FinalizeSyncService extends FinalizationStepService {
  static argumentTypes = [FinalizeSyncInput, FinalizationSettlementWriter];
  get settlementOutcome() { return super.settlementOutcome; }
  constructor(input, writer) {
    if (!(input instanceof FinalizeSyncInput) || !(writer instanceof FinalizationSettlementWriter)) {
      throw new TypeError("FinalizeSyncService requires typed input and a save-only writer");
    }
    super(input, writer);
  }
}
