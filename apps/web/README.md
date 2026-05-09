# `@helm/web`

Vite + React + TypeScript frontend for Helm, deployed via Amplify Hosting.

## Stack

| Layer | Choice |
|---|---|
| Build | Vite ^6 |
| UI framework | React ^19 + TypeScript ^5.7 (strict) |
| Styling | Tailwind CSS v4 (Vite plugin, no PostCSS config needed) |
| Components | shadcn/ui — `button`, `input`, `label`, `card` |
| Routing | React Router v6 |
| Server state | TanStack Query v5 |
| Forms | React Hook Form v7 + Zod v3 |
| Auth | aws-amplify v6 (`signIn`, `confirmSignIn`, `getCurrentUser`) |
| Tests | Vitest ^3 + @testing-library/react |

## Local development

```sh
# 1. Install dependencies (run from repo root)
pnpm install

# 2. Create your local env file and fill in values
cp apps/web/.env.example apps/web/.env.local

# 3. Start the dev server
pnpm --filter @helm/web dev
```

The four required env vars are:

```
VITE_API_URL              # API Gateway base URL (no trailing slash)
VITE_AWS_REGION           # e.g. ca-central-1
VITE_COGNITO_USER_POOL_ID # e.g. ca-central-1_XXXXXXXXX
VITE_COGNITO_USER_POOL_CLIENT_ID
```

`.env.local` is gitignored by the root `.gitignore`. See `.env.example` for
the exact keys and where to find the values (AWS Console or Amplify Console).

## Auth

Self-signup is **disabled**. Users are admin-created in Cognito with
`FORCE_CHANGE_PASSWORD` status. On first sign-in the app detects the
`CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED` challenge and renders a
"Set new password" form inline. After the password is set, the user lands on
`/clients`.

See `amplify/README.md` for how to create users in the Cognito pool.

## Tests

```sh
pnpm --filter @helm/web run test -- --run
```

15 tests across three suites:

- `tests/api.test.ts` — `apiFetch` helper (JWT injection, error handling, JSON parsing)
- `tests/SignIn.test.tsx` — sign-in form, Zod validation, FORCE_CHANGE_PASSWORD challenge flow
- `tests/ProtectedRoute.test.tsx` — auth guard redirect and passthrough

## Type-check

```sh
pnpm --filter @helm/web typecheck
```

Runs `tsc --noEmit` against both `tsconfig.app.json` (src/) and
`tsconfig.node.json` (vite.config.ts).

## Build

```sh
pnpm --filter @helm/web build
```

Outputs to `apps/web/dist/`. Amplify Hosting will pick this up once
`amplify.yml` is updated to build from `apps/web/` (see below).

## What is stubbed / next steps

| Item | Status |
|---|---|
| Client list | GET /business/clients — live against deployed Lambda |
| All other routes | Not yet implemented |
| PWA manifest + service worker | Deferred (next iteration) |
| Code-splitting | `aws-amplify` bundle is ~500 kB; split by route when routes grow |
| `amplify.yml` | Needs `baseDirectory: apps/web` + `pnpm --filter @helm/web build` |
| Amplify Console env vars | Must set the four `VITE_*` vars per branch (main/dev) |

## Human actions needed before deploying

1. **`amplify.yml`** — update to build `apps/web/` on push (out of scope for
   this step).
2. **Amplify Console env vars** — set the four `VITE_*` values under each
   branch's environment variable settings. The `main` branch values are
   documented in `.env.example` (without real values).
3. **`.env.local`** — create locally from `.env.example` before running
   `pnpm dev`.
