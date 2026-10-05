import { PromptLogicalFootprint, PromptRequestLimit, PromptFixedContextTooLargeFailure } from "./prompt-batching.js";

/** Measures the complete logical request and its provider command projection. */
export function gatePromptFits(request, limit = new PromptRequestLimit(), projectInvocation = null) {
  return PromptLogicalFootprint.measure(request).fits(limit)
    && (!projectInvocation || projectInvocation(request).fits(limit.maxCharacters));
}

/** Delivery policy only; the caller owns file creation, durability and disposal. */
export class PromptInputDeliveryDecision {
  constructor({ mode, request, limit, projectInvocation = null }) {
    if (!["inline", "file"].includes(mode)) throw new TypeError("Unknown prompt input delivery mode");
    this.mode = mode;
    this.request = request;
    this.footprint = PromptLogicalFootprint.measure(request);
    if (!this.footprint.fits(limit)) {
      throw new PromptFixedContextTooLargeFailure("Complete prompt input reference exceeds the request limit", {
        actualCharacters: this.footprint.total, maxCharacters: limit.maxCharacters,
      });
    }
    if (projectInvocation) projectInvocation(request).assertWithinLimit(limit.maxCharacters);
    Object.freeze(this);
  }

  static select({ inlineRequest, fileRequest, limit = new PromptRequestLimit(), projectInvocation = null }) {
    const mode = gatePromptFits(inlineRequest, limit, projectInvocation) ? "inline" : "file";
    return new this({ mode, request: mode === "inline" ? inlineRequest
      : typeof fileRequest === "function" ? fileRequest() : fileRequest, limit, projectInvocation });
  }
}
