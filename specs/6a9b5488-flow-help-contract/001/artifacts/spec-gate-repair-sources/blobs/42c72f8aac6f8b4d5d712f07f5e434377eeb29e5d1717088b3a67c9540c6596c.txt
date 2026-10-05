# Integration tests

Own filesystem, Git and Flow boundary scenarios. Start each from an immutable seed
copied to a unique temporary root; restore environment and remove roots in teardown.
Run `npm run test:integration`. Do not execute real AI providers here; use support
fakes.
