/** Quote one literal argument for the POSIX shell used by test fixtures. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
