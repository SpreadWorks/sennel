# Unit tests

Test isolated classes/functions with fakes only. Forbidden: `node:child_process`,
Git fixture helpers, and Flow scenario helpers. Run `npm run test:unit`. Put a
cross-module or filesystem/Git/Flow scenario in `../integration` instead.

The phase 02 Result contract runs in ordinary unit and full regression selection
through `structured-step-result-contract.test.js`. That entry imports shared
fixtures and generation contract tests from `structured-step-result.contract.js`;
those imported tests run too, despite the helper's `.contract.js` suffix.
`npm run test:contract:result` explicitly runs the generation contract alone.
Preserve the assertions and keep tests of introduced functionality in normal
discovery. Do not move failing regression tests out of that selection.
