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
 *  GET     /health        — unauthorised (liveness probe)
 *  OPTIONS /{proxy+}      — unauthorised, lets browser CORS preflights through
 *                           without a JWT (FastAPI's CORSMiddleware answers them)
 *  ANY     /{proxy+}      — JWT-authorised, proxy to Lambda
 *
 * The OPTIONS route is required because the JWT authoriser, when attached to
 * `ANY /{proxy+}`, intercepts preflights too and rejects them with 401 (the
 * browser never sends an Authorization header on preflights), which manifests
 * in the UI as opaque "Failed to fetch" / CORS errors.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
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
    // S3 bucket for uploaded receipts / supplier invoices.
    // Owned by this stack so the lifecycle is tied to the API.
    // -------------------------------------------------------------------------
    const receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      bucketName: `helm-receipts-${config.env}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy:
        config.env === 'main'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: config.env !== 'main',
      cors: [
        {
          // The frontend uploads via presigned PUT URL. Allow the
          // Amplify and local-dev origins. Wildcard for V1 — tighten
          // when prod domain is locked in.
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // The container image is shared between the HTTP API Lambda and
    // the S3-triggered processor — build it once.
    const apiImage = lambda.DockerImageCode.fromImageAsset(
      path.join(__dirname, '..', '..', 'services', 'api'),
    );

    // -------------------------------------------------------------------------
    // Lambda — container image built from services/api/
    // __dirname here is infra/lib/; services/api is two levels up then down.
    // -------------------------------------------------------------------------
    const fn = new lambda.DockerImageFunction(this, 'ApiFunction', {
      functionName: `helm-api-${config.env}`,
      code: apiImage,
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
        HELM_RECEIPTS_BUCKET: receiptsBucket.bucketName,
      },
    });

    // -------------------------------------------------------------------------
    // IAM grants
    // -------------------------------------------------------------------------
    // Allow Lambda to read the DB master credentials from Secrets Manager.
    secret.grantRead(fn);

    // Allow Lambda to call the RDS Data API on this cluster.
    cluster.grantDataApiAccess(fn);

    // Read/write access to the receipts bucket (for presigned URL
    // generation + the DELETE endpoint's S3 cleanup).
    receiptsBucket.grantReadWrite(fn);

    // -------------------------------------------------------------------------
    // Receipt processor Lambda — S3 ObjectCreated → Textract → DB update.
    // Same container image as the API Lambda, different entrypoint.
    // -------------------------------------------------------------------------
    const processorLogGroup = new logs.LogGroup(this, 'ReceiptProcessorLogs', {
      logGroupName: `/aws/lambda/helm-receipt-processor-${config.env}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy:
        config.env === 'main'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    const processorFn = new lambda.DockerImageFunction(
      this,
      'ReceiptProcessor',
      {
        functionName: `helm-receipt-processor-${config.env}`,
        code: apiImage,
        // Override the image's default CMD (the Mangum handler) so this
        // Lambda runs the S3-event handler instead.
        // The Lambda runtime calls the function named here on each event.
        // Docker image is layered on AWS's Python base image which uses
        // `lambda-entrypoint.sh` + the CMD as the handler path.
        memorySize: 1024,
        timeout: cdk.Duration.seconds(60),
        architecture: lambda.Architecture.ARM_64,
        logGroup: processorLogGroup,
        environment: {
          HELM_STAGE: config.env === 'main' ? 'prod' : config.env,
          HELM_DATABASE_NAME: databaseName,
          HELM_DATABASE_SECRET_ARN: secret.secretArn,
          HELM_DATABASE_RESOURCE_ARN: cluster.clusterArn,
          HELM_RECEIPTS_BUCKET: receiptsBucket.bucketName,
        },
      },
    );

    // Override the Docker image CMD to point at the processor handler.
    // The Dockerfile sets CMD ["app.main.handler"]; for this function
    // the runtime should call app.handlers.process_receipt.handler.
    (processorFn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'ImageConfig.Command',
      ['app.handlers.process_receipt.handler'],
    );

    // Same DB + S3 access as the API Lambda.
    secret.grantRead(processorFn);
    cluster.grantDataApiAccess(processorFn);
    receiptsBucket.grantRead(processorFn);

    // Textract permission — AnalyzeExpense (synchronous).
    processorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['textract:AnalyzeExpense'],
        resources: ['*'],
      }),
    );

    // Trigger: S3 ObjectCreated under the `expenses/` prefix.
    receiptsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processorFn),
      { prefix: 'expenses/' },
    );

    // Suppress unused-import warning for lambdaEventSources (re-exported
    // so future event-source additions don't need another import).
    void lambdaEventSources;

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

    // OPTIONS /{proxy+} — unauthenticated, lets browser preflights through.
    // API Gateway's route precedence picks this over `ANY /{proxy+}` for the
    // OPTIONS method, so the JWT authoriser is bypassed for preflights only.
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: lambdaIntegration,
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
