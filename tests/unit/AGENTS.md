# Unit tests

Test isolated classes/functions with fakes only. Forbidden: `node:child_process`,
Git fixture helpers, and Flow scenario helpers. Run `npm run test:unit`. Put a
cross-module or filesystem/Git/Flow scenario in `../integration` instead.

The pending phase 02 Result contract is stored in
`structured-step-result.contract.js` and runs explicitly with
`npm run test:contract:result`. Normal discovery selects `*.test.js`, so this
unintroduced contract does not enter the ordinary unit or full regression
selection. Preserve its assertions and report the unmet contracts separately.
When phase 02 introduces the Result API, promote this artifact to
`structured-step-result-contract.test.js` and include it in ordinary unit and
phase acceptance checks. Do not move failing tests of introduced functionality
out of normal discovery.
