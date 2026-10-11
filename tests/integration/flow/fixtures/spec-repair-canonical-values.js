/** Legal Task criteria whose complete JSON value is exactly 34,522 UTF-8 bytes. */
export function canonicalLargeTaskAcceptance() {
  return [...Array.from({ length: 22 }, () => "受".repeat(500)), "受".repeat(484)];
}
