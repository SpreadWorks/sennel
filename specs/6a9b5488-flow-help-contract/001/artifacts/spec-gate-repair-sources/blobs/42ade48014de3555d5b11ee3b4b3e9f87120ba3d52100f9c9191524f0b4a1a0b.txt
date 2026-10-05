# Support

Contains reusable test support, never runner selection policy or tests.
`builders/` creates fixture roots and snapshots, `fakes/` contains deterministic
agents, and `infrastructure/` owns Git, Flow, lock and process helpers. Helpers
must create caller-owned temporary roots and expose cleanup; consumers clean up
in teardown.
