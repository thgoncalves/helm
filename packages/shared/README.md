# `@helm/shared`

Types and constants shared across the TypeScript side of the workspace
(`apps/web`, `db`, `amplify`, `infra`).

## Contents (planned)

- **`api-types/`** — TypeScript types **generated** from
  `services/api/openapi.json` via `openapi-typescript`. Committed so
  consumers don't need a build step. Regenerate with `pnpm api:types`.
- **`constants/`** — non-secret constants used in both web and node
  contexts (e.g. invoice number format, default GST fallback).
- **`validators/`** — small TS validators that don't need Pydantic
  (e.g. invoice-number regex check).

## Status

Folder reserved.
