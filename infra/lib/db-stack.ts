/**
 * DbStack — Aurora Serverless v2 PostgreSQL with RDS Data API.
 *
 * Provisions:
 *  - A minimal VPC (2 AZs, isolated subnets — Data API is HTTP-based,
 *    Lambda needs no VPC peering).
 *  - An Aurora Serverless v2 PostgreSQL 16 cluster with the Data API enabled
 *    and scale-to-zero configured.
 *  - A Secrets Manager secret for the master credentials (auto-generated
 *    by CDK RDS helper).
 *
 * Public properties let ApiStack consume the cluster ARN, secret ARN, and
 * database name without hard-coding ARNs anywhere.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { EnvConfig } from '../config/main.js';

export interface DbStackProps extends cdk.StackProps {
  config: EnvConfig;
}

export class DbStack extends cdk.Stack {
  /** The Aurora Serverless v2 cluster. */
  public readonly cluster: rds.DatabaseCluster;

  /** Secrets Manager secret holding the master credentials. */
  public readonly secret: secretsmanager.ISecret;

  /** Default database name inside the cluster. */
  public readonly databaseName: string;

  constructor(scope: Construct, id: string, props: DbStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.env === 'main';

    this.databaseName = 'helm';

    // -------------------------------------------------------------------------
    // VPC — isolated subnets only.  The RDS Data API endpoint is an AWS
    // service endpoint (HTTPS) so Lambda never needs to be in the same VPC.
    // We still need a VPC for Aurora itself; isolated subnets keep the cluster
    // off the public internet with no NAT gateway cost.
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // Aurora Serverless v2 PostgreSQL 16
    // -------------------------------------------------------------------------
    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0,   // scale-to-zero (released 2024-Nov)
      serverlessV2MaxCapacity: 2,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      defaultDatabaseName: this.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret('helm_admin', {
        secretName: `helm/${config.env}/db-credentials`,
      }),
      enableDataApi: true,
      backup: {
        retention: isProd
          ? cdk.Duration.days(7)
          : cdk.Duration.days(1),
      },
      deletionProtection: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
    });

    this.cluster = cluster;

    // The secret is auto-created by fromGeneratedSecret; expose it via the
    // cluster's secret property (guaranteed non-null when using fromGeneratedSecret).
    this.secret = cluster.secret!;

    // -------------------------------------------------------------------------
    // CloudFormation outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterArn', {
      exportName: `helm-${config.env}-ClusterArn`,
      value: cluster.clusterArn,
      description: 'Aurora Serverless v2 cluster ARN',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      exportName: `helm-${config.env}-SecretArn`,
      value: this.secret.secretArn,
      description: 'Secrets Manager secret ARN for Aurora master credentials',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      exportName: `helm-${config.env}-DatabaseName`,
      value: this.databaseName,
      description: 'Default database name inside the Aurora cluster',
    });
  }
}
