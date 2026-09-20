/** Shared nominal type for validated write-side and persisted Draft settlement receipts. */
export class DraftStepSettlementReceiptValue {
  constructor() {
    if (new.target === DraftStepSettlementReceiptValue) {
      throw new TypeError("Draft settlement receipt values are abstract");
    }
  }
}
