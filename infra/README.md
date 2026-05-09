# `infra/` — CDK stacks

CDK stacks for resources that live outside Amplify Gen 2's first-class set.
See [`docs/architecture.md`](../docs/architecture.md) for the full system picture.

## What's here

| Stack | Name pattern | What it creates |
|---|---|---|
| **DbStack** (`lib/db-stack.ts`) | `helm-db-<env>` | Aurora Serverless v2 PostgreSQL 16 cluster, RDS Data API enabled, Secrets Manager secret for master credentials, isolated VPC (no NAT). |
| **ApiStack** (`lib/api-stack.ts`) | `helm-api-<env>` | Lambda DockerImageFunction (FastAPI/Mangum, arm64), API Gateway HTTP API, Cognito JWT authoriser, IAM grants for Secrets Manager + RDS Data API. |

### DbStack outputs

| Output | Description |
|---|---|
| `ClusterArn` | Aurora cluster ARN — used by `rds-data:ExecuteStatement` calls |
| `SecretArn` | Secrets Manager ARN for master credentials |
| `DatabaseName` | Default DB name (`helm`) |

### ApiStack outputs

| Output | Description |
|---|---|
| `ApiUrl` | API Gateway HTTP API invoke URL |

### Route layout

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | None | Liveness probe |
| `ANY /{proxy+}` | Cognito JWT | All application routes (proxied to Lambda) |

## Environments

| Context `env` | Stack names | Cognito pool |
|---|---|---|
| `main` | `helm-db-main`, `helm-api-main` | `ca-central-1_QTDeN4z06` (hardcoded in `config/main.ts`) |
| `dev` | `helm-db-dev`, `helm-api-dev` | Not yet deployed — fill in `config/dev.ts` once the dev Amplify backend is live |

## How to deploy

### Prerequisites

- CDK already bootstrapped for account `326543321262` / `ca-central-1` (`CDKToolkit` stack exists).
- AWS CLI profile `helm` configured with credentials for that account.
- `pnpm` installed (repo uses pnpm workspaces).
- Docker running locally (CDK builds the Lambda container image during `cdk synth`).

### First-time setup

```sh
# From the repo root — installs infra deps alongside all other workspace packages.
pnpm install --filter '@helm/infra...'

# Type-check (must pass before deploying)
pnpm --filter @helm/infra typecheck

# Local synth check (no AWS calls, no Docker build)
pnpm --filter @helm/infra synth
```

### Find the Cognito User Pool Client ID (required for main)

```sh
aws --profile helm cognito-idp list-user-pool-clients \
  --user-pool-id ca-central-1_QTDeN4z06 \
  --query 'UserPoolClients[].{Name:ClientName,Id:ClientId}'
```

Copy the `Id` from the Amplify-created client (the one whose `Name` starts with `amplify`).

### Deploy to main (production)

```sh
pnpm --filter @helm/infra exec cdk deploy --all -c env=main -c userPoolClientId=<id-from-aws-cli> --profile helm --require-approval never
```

`pnpm run` does not forward extra flags reliably through the script's `--`,
so invoke `cdk` directly via `pnpm exec`. This bypasses the `deploy:main`
script but is the only way to pass `-c userPoolClientId=...` cleanly.

### Deploy to dev

First ensure `config/dev.ts` has the correct `userPoolId` (deploy the dev Amplify
backend first, then grab the pool ID from the Amplify Console or CloudFormation).

```sh
pnpm --filter @helm/infra exec cdk deploy --all -c env=dev -c userPoolClientId=<dev-client-id> --profile helm --require-approval never
```

### Diff before deploy

```sh
pnpm --filter @helm/infra exec cdk diff -c env=main -c userPoolClientId=<id> --profile helm
```

## Judgement calls / design decisions

| Decision | Choice | Rationale |
|---|---|---|
| VPC subnet type | `PRIVATE_ISOLATED` (no NAT) | Lambda uses the Data API (HTTPS service endpoint) — it never needs to be in the same VPC. Aurora still needs a VPC; isolated subnets avoid NAT gateway cost (~$32/mo). |
| Aurora PostgreSQL version | 16.6 | Latest stable at time of writing; matches Data API support. |
| Lambda architecture | `arm64` | Graviton2 — ~20% cheaper + faster than x86 for the same memory. AWS Lambda Python 3.12 supports arm64. |
| Lambda memory | 1024 MB | FastAPI + Mangum cold start is 600–1000 ms; 1 GB balances cold-start speed vs cost. Tune with provisioned concurrency once usage is known. |
| Log retention | 1 month (`RetentionDays.ONE_MONTH`) | Enough for debugging; avoids unbounded CloudWatch cost. |
| CORS | `allowOrigins: ['*']` | Permissive for now; tighten to the Amplify Hosting domain once it's known. `allowCredentials` cannot be `true` with `*` origins, so it is omitted. |
| JWT audience | Loud placeholder string (`[NotYetConfigured-supply-userPoolClientId-context]`) when `userPoolClientId` not supplied | Synth succeeds; every runtime request is rejected because no real token will match the placeholder audience. Intentionally traceable in CloudWatch. Always supply `-c userPoolClientId=<id>` before deploying. |
| Dev synth behaviour | Synthesise with `[NotYetSet]` placeholder | Allows `cdk synth` to complete for dev without blocking on a Cognito pool that doesn't exist yet. A warning is printed. Do NOT deploy dev with the placeholder. |
| Removal policy | `RETAIN` (main) / `DESTROY` (dev) | Protects production data from accidental `cdk destroy`. Dev clusters can be recreated cheaply. |

## What's stubbed

The Lambda runs `services/api/app/main.py` which currently returns in-memory
data for `GET /business/clients` and `POST /business/clients`.  The Lambda
will respond correctly through API Gateway but will not query PostgreSQL yet.

The next step is `services/api/app/db.py` — an RDS Data API client using
`boto3` (`rds-data` service).  Once that exists, replace the in-memory stubs
in `services/api/app/routers/clients.py` with real SQL.

## Timing expectations

- First `cdk deploy` for the db stack takes **10–15 minutes** — Aurora cluster
  creation is slow regardless of serverless configuration.
- Subsequent deploys (code changes only) take ~2–3 minutes (Lambda image push +
  API Gateway update).
- Scale-to-zero means the first query after the cluster idles takes ~5–10 s to
  warm up (Aurora re-provisions the writer ACU).
