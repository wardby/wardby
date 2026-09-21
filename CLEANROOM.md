# Clean-Room Charter

wardby is an **independent reimplementation** built from behavioral
specifications. It is not derived from, and does not copy, any other codebase.

## Permitted inputs

- The private behavioral specifications retained by the author (kept in
  `docs/private/`, which is git-ignored and never published).
- Public standards, RFCs, and protocol documentation.
- Public documentation for third-party libraries and cloud SDKs.

## Prohibited inputs

- Any other project's source code, database schema, migration files, or
  configuration.
- Any verbatim excerpt copied from such a codebase.

## Rules

1. **Implement only from the spec.** During development, the specifications in
   `docs/private/` and public references are the only permitted inputs. Do not
   open, reference, or copy any other codebase.
2. **Regenerate every artifact.** `prisma/schema.prisma` and all migrations are
   hand-written from the spec's data-model description — never copied. The same
   applies to every source file.
3. **Interfaces from the spec.** Provider interfaces (`src/providers/*/types.ts`)
   are designed from the behavioral spec. Cloud adapters are written against the
   public SDKs of the services they target.
4. **Contributors affirm the same.** Contributions are made under the project
   license and the Developer Certificate of Origin (see `CONTRIBUTING.md`); by
   signing off, contributors certify their work is their own and not copied.

## Copyright & attribution — deferred

No copyright is asserted in this repository yet. The `LICENSE` file carries
the Apache-2.0 text with a blank `[name of copyright owner]` placeholder, and
there is intentionally **no `NOTICE` file**.

Ownership of this work is unresolved pending a rights conversation with a prior
employer. Until that is settled in writing, this repository asserts no
copyright holder. When ownership is resolved, add the copyright line and a
`NOTICE` file naming the agreed holder — do not assert one before then.

This charter is committed from the project's first commit as a record of the
clean-room discipline under which wardby is built.
