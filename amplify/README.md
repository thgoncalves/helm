# `amplify/` — Amplify Gen 2 backend

Defines the Amplify-managed parts of the Helm backend using
`@aws-amplify/backend` (Gen 2, CDK underneath).

See [`docs/architecture.md`](../docs/architecture.md) for the full system
picture. Resources that live *outside* this folder (`infra/` — API Gateway,
FastAPI Lambda, Aurora) are separate CDK stacks and are not managed here.

## What's defined

| Resource | Type | Details |
|---|---|---|
| `auth` | Cognito User Pool | Email/password sign-in. Self-signup **disabled** — accounts must be created by an administrator. Password minimum 12 chars; requires lowercase, uppercase, number, symbol. Account recovery via email only. No federation (V1). |
| `receipts` | S3 bucket | Receipt images. Private per Cognito identity: `receipts/{entity_id}/*`. Marked as the default storage resource. |
| `documents` | S3 bucket | Generated PDFs (timesheets, invoices) and CSV imports. Private per Cognito identity: `documents/{entity_id}/*`. |

Amplify generates the actual AWS bucket names (e.g.
`amplify-helm-main-receipts-<hash>`). The `name` field in each
`defineStorage()` call is the logical name used in the codebase.

## Local development (sandbox)

```sh
# From the repo root — provisions a personal AWS sandbox tied to your IAM identity.
# Hot-reloads on backend changes. Safe to run; tears down on Ctrl-C.
pnpm --filter @helm/amplify sandbox
```

The sandbox connects to the AWS account configured in your local AWS profile
(`AWS_PROFILE` or `~/.aws/credentials`). The account must be bootstrapped
for CDK (`CDKToolkit` stack must exist) — it already is for `326543321262 /
ca-central-1`.

## Deploying

Amplify Console picks up `amplify/backend.ts` from the `main` branch (prod
environment) and the `dev` branch (dev environment) on push, then runs:

```sh
ampx pipeline-deploy
```

Auto-build is currently **disabled** in the Amplify Console and will be
re-enabled once this backend definition lands on `main`.

Each environment gets its own isolated Cognito pool, S3 buckets, and (once
wired) Amplify Hosting app.

## Seeding an initial user

Because self-signup is disabled, you must create the first user manually after
the first deploy:

```sh
# Replace <user-pool-id> with the pool ID from the Amplify Console or CloudFormation output.
aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username <your-email@example.com> \
  --temporary-password '<TempP@ss1234>' \
  --user-attributes Name=email,Value=<your-email@example.com> Name=email_verified,Value=true
```

The user will be prompted to set a permanent password on first sign-in.

## What's NOT here

- `infra/` — Aurora Serverless v2, API Gateway HTTP API, FastAPI Lambda. These
  are separate CDK stacks. See [`infra/`](../infra/) and
  [`docs/architecture.md`](../docs/architecture.md).
- Frontend — lives in [`apps/web/`](../apps/web/).
- Drizzle schema and migrations — [`db/`](../db/).
