# `amplify` — Amplify Gen 2 backend

Defines the parts where Amplify gives a real productivity boost:
**Cognito** (auth), **S3** (storage), and **Hosting** (branch deploys).
Deploys automatically on push to `main` (prod) and `dev` (dev environment).

## Planned layout

```
amplify/
├── auth/               # Cognito User Pool definition
├── storage/            # S3 buckets (helm-receipts-{env}, helm-documents-{env})
└── backend.ts          # defineBackend({ auth, storage, ... })
```

## Why both `amplify/` and `infra/`?

Amplify Gen 2 is CDK underneath. It owns auth + storage + hosting because
those are first-class. Everything else — API Gateway, FastAPI Lambda,
Aurora — lives in `infra/` as raw CDK because they're outside Amplify's
first-class set. Both stacks deploy to the same AWS account.

## Local development

```sh
npx ampx sandbox
```

Provisions a per-developer sandbox env scoped to your IAM identity,
hot-reloading on changes.

## Status

Folder reserved.
