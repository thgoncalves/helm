# `@helm/web`

Vite + React + TypeScript frontend, deployed via Amplify Hosting.

PWA-enabled for iPhone install + camera capture
(`<input type="file" accept="image/*" capture="environment">`).
Authenticates against Cognito with `@aws-amplify/auth`. Uploads receipts and
documents directly to S3 with `@aws-amplify/storage`. Calls the FastAPI
backend via `fetch` with the Cognito JWT in `Authorization`.

## Type safety with the API

Imports generated TypeScript types from `@helm/shared/api-types`. These
are regenerated whenever `services/api/openapi.json` changes
(`pnpm api:types` once it's wired up).

## Status

Folder reserved. Initialise with:

```sh
pnpm create vite@latest apps/web -- --template react-ts
```

once we kick off implementation.
