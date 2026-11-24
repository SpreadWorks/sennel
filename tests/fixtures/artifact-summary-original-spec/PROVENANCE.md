# Original Spec summary input

`spec.json` is an immutable copy of the original regression specimen. It was
retrieved without parsing, rewriting, or regeneration from Git object:

- Source commit: `ff370a4da3b1abc2f9e129a687d56fa59ad26789`
- Source path: `specs/6a9b5488-flow-help-contract/001/spec.json`
- Deletion commit: `874b47dfe` (the source commit is its first parent)
- Byte length: `84467`
- SHA-256: `df142f1dd06136fdfe83763037bc53d338d135943844cb533002d42497a238bc`

The artifact summary input-limit test previously read that deleted repository
path directly. This seed preserves its original input and assertions, including
the 60000-character request budget, all source units, exact excerpts, cache
reload across CLI processes, and unchanged canonical artifacts. It is a Spec
input specimen, not a reconstructed runtime state or proof of historical Flow
continuation.

Retrieve the original bytes with:

```text
git show 874b47dfe^:specs/6a9b5488-flow-help-contract/001/spec.json
```

The local `.gitattributes` marks `spec.json -text` so Git preserves the exact
bytes even when a checkout enables line-ending conversion. Tests verify both
byte length and SHA-256 before using the seed and check that its bytes remain
unchanged in teardown. Do not update the hash to accommodate a changed specimen.
