# `infra` — CDK stacks

CDK stacks for resources outside Amplify Gen 2's first-class set:

- **API Gateway HTTP API** with Cognito JWT authoriser
- **Lambda function** running the FastAPI app (container image from ECR)
- **Aurora Serverless v2 PostgreSQL** with the **RDS Data API**
- **Secrets Manager** (Aurora credentials), **CloudWatch** alarms, IAM

These stacks cross-reference the Cognito User Pool that
`amplify/auth/` creates.

## Planned layout

```
infra/
├── bin/                # CDK app entry
├── lib/
│   ├── api-stack.ts    # API Gateway + Lambda(FastAPI)
│   ├── db-stack.ts     # Aurora Serverless v2
│   └── shared-stack.ts # Shared IAM, Secrets
├── cdk.json
└── package.json
```

## Status

Folder reserved.
