function promptPart(value) {
  return String(value || "");
}

/** Exact provider-visible character accounting for structured review prompts. */
export class ReviewPromptSize {
  constructor({ systemPrompt, userPrompt, fmtFallback } = {}) {
    this.systemPrompt = promptPart(systemPrompt).length;
    this.userPrompt = promptPart(userPrompt).length;
    this.fmtFallback = promptPart(fmtFallback).length;
    this.total = this.systemPrompt + this.userPrompt + this.fmtFallback;
    Object.freeze(this);
  }

  static measure(prompt) {
    if (prompt && typeof prompt === "object" && "userPrompt" in prompt) {
      return new ReviewPromptSize(prompt);
    }
    return new ReviewPromptSize({ userPrompt: prompt });
  }

  toJSON() {
    return {
      systemPrompt: this.systemPrompt,
      userPrompt: this.userPrompt,
      fmtFallback: this.fmtFallback,
      total: this.total,
    };
  }
}

export function measureReviewPromptChars(prompt) {
  return ReviewPromptSize.measure(prompt).total;
}
