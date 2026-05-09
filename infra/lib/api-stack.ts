/**
 * ApiStack — Lambda (FastAPI / Mangum) + API Gateway HTTP API.
 *
 * Provisions:
 *  - A Lambda DockerImageFunction built from services/api (container image).
 *  - An API Gateway HTTP API with a Cognito JWT authoriser.
 *  - IAM grants so Lambda can read DB credentials and call the RDS Data API.
 *
 * The JWT authoriser validates tokens issued by the Amplify-managed Cognito
 * User Pool before forwarding requests to Lambda.  If `userPoolClientId` is
 * not supplied via CDK context, the authoriser is configured with a
 * placeholder audience and ALL requests will be rejected at runtime.
 * Always supply `-c userPoolClientId=<id>` before deploying.
 *
 * Route layout:
 *  GET  /health         — unauthorised (liveness probe)
 *  ANY  /{proxy+}       — JWT-authorised, proxy to Lambda
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { EnvConfig } from '../config/main.js';

// ESM-compatible __dirname (package.json "type": "module" requires this)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ApiStackProps extends cdk.StackProps {
  config: EnvConfig;
  cluster: rds.DatabaseCluster;
  secret: secretsmanager.ISecret;
  databaseName: string;
}

export class ApiStack extends cdk.Stack {
  /** The API Gateway HTTP API invoke URL. */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, cluster, secret, databaseName } = props;

    // -------------------------------------------------------------------------
    // CloudWatch Log Group — explicit retention; avoids the deprecated
    // `logRetention` property on DockerImageFunction.
    // -------------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'ApiFunctionLogs', {
      logGroupName: `/aws/lambda/helm-api-${config.env}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy:
        config.env === 'main'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // Lambda — container image built from services/api/
    // __dirname here is infra/lib/; services/api is two levels up then down.
    // -------------------------------------------------------------------------
    const fn = new lambda.DockerImageFunction(this, 'ApiFunction', {
      functionName: `helm-api-${config.env}`,
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '..', '..', 'services', 'api'),
      ),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.ARM_64,
      logGroup,
      environment: {
        // Must match the HELM_ prefix in services/api/app/config.py.
        // Map branch name → env name: main → prod, dev → dev. The Pydantic
        // Settings stage is Literal["dev", "prod", "local"] — sending "main"
        // would ValidationError at cold start.
        HELM_STAGE: config.env === 'main' ? 'prod' : config.env,
        HELM_DATABASE_NAME: databaseName,
        HELM_DATABASE_SECRET_ARN: secret.secretArn,
        HELM_DATABASE_RESOURCE_ARN: cluster.clusterArn,
      },
    });

    // -------------------------------------------------------------------------
    // IAM grants
    // -------------------------------------------------------------------------
    // Allow Lambda to read the DB master credentials from Secrets Manager.
    secret.grantRead(fn);

    // Allow Lambda to call the RDS Data API on this cluster.
    cluster.grantDataApiAccess(fn);

    // -------------------------------------------------------------------------
    // API Gateway HTTP API
    // -------------------------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `helm-api-${config.env}`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['*'],
        // Note: `allowCredentials` cannot be true when allowOrigins is ['*'].
        // Tighten both when the frontend domain is known.
      },
      createDefaultStage: true,
    });

    // -------------------------------------------------------------------------
    // JWT authoriser — Cognito User Pool
    // -------------------------------------------------------------------------
    // The issuer URL follows the Cognito standard format.
    const issuer = `https://cognito-idp.ca-central-1.amazonaws.com/${config.userPoolId}`;

    // Audience: use the specific client ID if provided.
    // If not, fall back to a placeholder so `cdk synth` succeeds — but ALL
    // runtime requests will be rejected by API Gateway until a real client ID
    // is supplied.
    //
    // TODO (hardening): always supply -c userPoolClientId=<id> before deploying.
    const resolvedClientId =
      config.userPoolClientId != null && config.userPoolClientId !== ''
        ? config.userPoolClientId
        : '[NotYetConfigured-supply-userPoolClientId-context]';

    if (!config.userPoolClientId) {
      console.warn(
        `[helm/infra] WARNING: userPoolClientId not set for env=${config.env}.\n` +
          'JWT authoriser audience is a placeholder; all API requests will fail\n' +
          'until you redeploy with: -c userPoolClientId=<real-client-id>',
      );
    }

    const authorizer = new apigwv2authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      issuer,
      {
        jwtAudience: [resolvedClientId],
        authorizerName: `helm-cognito-${config.env}`,
        identitySource: ['$request.header.Authorization'],
      },
    );

    // -------------------------------------------------------------------------
    // Lambda integration (shared)
    // -------------------------------------------------------------------------
    const lambdaIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      fn,
    );

    // GET /health — unauthenticated liveness probe
    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
      // No authorizer — open to health checkers / load balancers
    });

    // ANY /{proxy+} — all other routes require a valid Cognito JWT
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
      authorizer,
    });

    this.apiUrl = httpApi.apiEndpoint;

    // -------------------------------------------------------------------------
    // CloudFormation output
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      exportName: `helm-${config.env}-ApiUrl`,
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API invoke URL',
    });
  }
}
