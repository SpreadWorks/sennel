export class TestSuite {
  constructor(name, concurrency, includeByDefault = true) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("invalid test suite name");
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("test suite concurrency must be a positive integer");
    this.name = name;
    this.directory = name;
    this.concurrency = concurrency;
    this.includeByDefault = includeByDefault;
    Object.freeze(this);
  }
}

export const TEST_SUITES = Object.freeze([
  new TestSuite("unit", 4),
  new TestSuite("integration", 2),
  new TestSuite("e2e", 2),
  new TestSuite("acceptance", 1),
  new TestSuite("structure", 1),
  new TestSuite("agent", 1, false),
]);

export const TEST_SUITE_NAMES = Object.freeze(TEST_SUITES.map(({ name }) => name));
export const DEFAULT_TEST_SUITES = Object.freeze(TEST_SUITES.filter(({ includeByDefault }) => includeByDefault));
