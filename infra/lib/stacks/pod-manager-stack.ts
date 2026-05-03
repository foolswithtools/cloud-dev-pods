import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import * as path from 'path';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';
import type { ClusterStack } from './cluster-stack';
import type { NetworkStack } from './network-stack';
import type { PodTaskFamilyStack } from './pod-task-family-stack';

export interface PodManagerStackProps extends StackProps {
  config: Config;
  network: NetworkStack;
  cluster: ClusterStack;
  taskFamily: PodTaskFamilyStack;
}

/**
 * Pod-manager Lambda + DynamoDB registry. Sole holder of ECS/ALB/EFS write
 * permissions per ADR 0003.
 *
 * The PodOpsRole (BootstrapStack, Phase 4) is pinned to invoke a function
 * literally named `pod-manager` — this stack must preserve that name.
 */
export class PodManagerStack extends Stack {
  public readonly registry: dynamodb.Table;
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: PodManagerStackProps) {
    super(scope, id, props);
    const { config, network, cluster, taskFamily } = props;

    this.registry = new dynamodb.Table(this, 'Registry', {
      tableName: 'cloud-dev-pods-registry',
      partitionKey: { name: 'podName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.fn = new NodejsFunction(this, 'PodManagerFn', {
      functionName: 'pod-manager',
      entry: path.join(__dirname, '..', '..', 'lambda', 'pod-manager', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'PodManagerLogs', {
        logGroupName: '/aws/lambda/pod-manager',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        // @aws-sdk/* is provided by the Lambda runtime — exclude from bundle.
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        REGISTRY_TABLE_NAME: this.registry.tableName,
        CLUSTER_NAME: cluster.cluster.clusterName,
        EFS_FILESYSTEM_ID: cluster.fileSystem.fileSystemId,
        ALB_LISTENER_ARN: cluster.listener.listenerArn,
        ALB_LISTENER_PROTOCOL: cluster.listenerProtocol,
        ALB_DNS_NAME: cluster.alb.loadBalancerDnsName,
        BROWSER_TASK_DEF_FAMILY: taskFamily.browserTaskDef.family,
        TUNNEL_TASK_DEF_FAMILY: taskFamily.tunnelTaskDef.family,
        BROWSER_TASK_ROLE_ARN: taskFamily.browserTaskRole.roleArn,
        TUNNEL_TASK_ROLE_ARN: taskFamily.tunnelTaskRole.roleArn,
        EXECUTION_ROLE_ARN: taskFamily.executionRole.roleArn,
        PODS_LOG_GROUP_NAME: cluster.podsLogGroup.logGroupName,
        VPC_ID: network.vpc.vpcId,
        PRIVATE_SUBNET_IDS: network.vpc.privateSubnets.map((s) => s.subnetId).join(','),
        TASKS_SECURITY_GROUP_ID: network.tasksSg.securityGroupId,
        BASE_DOMAIN: config.domain.baseDomain ?? '',
        DOMAIN_STRATEGY: config.domain.strategy,
        BROWSER_REPO_URI: `${config.aws.accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/cloud-dev-pods/vscode-browser`,
        TUNNEL_REPO_URI: `${config.aws.accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/cloud-dev-pods/vscode-tunnel`,
        BROWSER_REPO_NAME: 'cloud-dev-pods/vscode-browser',
        TUNNEL_REPO_NAME: 'cloud-dev-pods/vscode-tunnel',
        AWS_ACCOUNT_ID: config.aws.accountId,
      },
    });

    // DDB grants
    this.registry.grantReadWriteData(this.fn);

    // ECS / ALB / EFS write rights — the actual privileges that PodOpsRole
    // would NOT have if it called these APIs directly.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:RegisterTaskDefinition',
          'ecs:DeregisterTaskDefinition',
          'ecs:DescribeTaskDefinition',
          'ecs:RunTask',
          'ecs:StopTask',
          'ecs:ListTasks',
          'ecs:DescribeTasks',
          'ecs:TagResource',
        ],
        resources: ['*'],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticloadbalancing:CreateRule',
          'elasticloadbalancing:DeleteRule',
          'elasticloadbalancing:ModifyRule',
          'elasticloadbalancing:CreateTargetGroup',
          'elasticloadbalancing:DeleteTargetGroup',
          'elasticloadbalancing:RegisterTargets',
          'elasticloadbalancing:DeregisterTargets',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetHealth',
          'elasticloadbalancing:DescribeRules',
          'elasticloadbalancing:DescribeListeners',
          'elasticloadbalancing:AddTags',
        ],
        resources: ['*'],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:CreateAccessPoint',
          'elasticfilesystem:DeleteAccessPoint',
          'elasticfilesystem:DescribeAccessPoints',
          'elasticfilesystem:TagResource',
        ],
        resources: ['*'],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:DescribeImages', 'ecr:BatchGetImage'],
        resources: [
          `arn:aws:ecr:${config.aws.region}:${config.aws.accountId}:repository/cloud-dev-pods/*`,
        ],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          taskFamily.executionRole.roleArn,
          taskFamily.browserTaskRole.roleArn,
          taskFamily.tunnelTaskRole.roleArn,
        ],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${config.aws.region}:${config.aws.accountId}:parameter/cloud-dev-pods/*`,
        ],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets', 'route53:GetChange'],
        resources: ['*'],
      }),
    );
    if (config.domain.strategy === 'byo' && config.domain.hostedZoneId) {
      // Tighter scoping when we know the zone.
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['route53:ChangeResourceRecordSets'],
          resources: [`arn:aws:route53:::hostedzone/${config.domain.hostedZoneId}`],
        }),
      );
    }
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents', 'logs:GetLogEvents', 'logs:DescribeLogStreams'],
        resources: [
          `arn:aws:logs:${config.aws.region}:${config.aws.accountId}:log-group:${cluster.podsLogGroup.logGroupName}:*`,
        ],
      }),
    );

    new ssm.StringParameter(this, 'PodManagerArnParam', {
      parameterName: ssmParamPath(config, 'pod-manager/function-arn'),
      stringValue: this.fn.functionArn,
    });
    new ssm.StringParameter(this, 'RegistryTableNameParam', {
      parameterName: ssmParamPath(config, 'pod-manager/registry-table-name'),
      stringValue: this.registry.tableName,
    });

    NagSuppressions.addResourceSuppressions(
      this.fn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'pod-manager is the sole holder of ECS/ALB/EFS write rights (ADR 0003). Wildcard resources on ECS/ELBv2/EFS APIs are required because resource ARNs are determined at runtime per pod-up. Bounded by `iam:PassRole` Condition (ECS service only) and ECR scoped to `cloud-dev-pods/*`.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access. CDK auto-attaches it to the function execution role.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true,
    );
  }
}
