/**
 * Maximum character count for one same-spec semantic context section.
 *
 * Gate processing and human artifact summaries both operate on canonical
 * Spec-derived content. Keeping their limit in one module prevents the two
 * paths from silently diverging.
 */
export const MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS = 48_000;
