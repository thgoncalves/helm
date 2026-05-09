# Architecture Decision Records (ADRs)

ADRs capture decisions that aren't already covered in
[`../architecture.md`](../architecture.md), and any later changes that
revise or refine choices made there.

## Format

`NNN-short-title.md` — sequentially numbered, kebab-case.

Each ADR:

- **Status** (proposed / accepted / superseded)
- **Date**
- **Context** — what problem prompted this decision
- **Decision** — what we chose
- **Consequences** — implications, trade-offs, follow-ups

## Existing high-level decisions (2026-05-08)

The V1 stack choices (Postgres, FastAPI on Lambda, PWA, Amplify Gen 2 +
CDK split, etc.) are documented inline in
[`../architecture.md`](../architecture.md) under
"Decisions locked". Future ADRs start when a later change revises one of
those, or when we make a new decision big enough to deserve its own
record.
