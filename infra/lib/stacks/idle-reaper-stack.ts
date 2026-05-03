import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import * as path from 'path';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';
import type { ClusterStack } from './cluster-stack';
import type { PodManagerStack } from './pod-manager-stack';

export interface IdleReaperStackProps extends StackProps {
  config: Config;
  cluster: ClusterStack;
  podManager: PodManagerStack;
}

/**
 * Idle reaper. Two-phase shutdown for browser pods + cleanup of orphaned ALB
 * resources when an ECS task stops outside the normal pod-down flow.
 */
export class IdleReaperStack extends Stack {
  public readonly fn: NodejsFunction;
  public readonly idleTopic: sns.Topic;
  public readonly scheduleRule: events.Rule;
  public readonly taskStateChangeRule: events.Rule;

  constructor(scope: Construct, id: string, props: IdleReaperStackProps) {
    super(scope, id, props);
    const { config, cluster, podManager } = props;

    this.idleTopic = new sns.Topic(this, 'IdleTopic', {
      topicName: 'cloud-dev-pods-idle-warnings',
      displayName: 'cloud-dev-pods idle warnings',
      enforceSSL: true,
    });

    this.fn = new NodejsFunction(this, 'IdleReaperFn', {
      functionName: 'pod-idle-reaper',
      entry: path.join(__dirname, '..', '..', 'lambda', 'idle-reaper', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'IdleReaperLogs', {
        logGroupName: '/aws/lambda/pod-idle-reaper',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        REGISTRY_TABLE_NAME: podManager.registry.tableName,
        POD_MANAGER_FN_NAME: podManager.fn.functionName,
        IDLE_TOPIC_ARN: this.idleTopic.topicArn,
        IDLE_MINUTES_DEFAULT: String(config.pods.idleMinutes ?? 60),
      },
    });

    podManager.registry.grantReadWriteData(this.fn);
    podManager.fn.grantInvoke(this.fn);
    this.idleTopic.grantPublish(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:GetMetricStatistics'],
        resources: ['*'],
      }),
    );

    // Every-5-min idle scan.
    this.scheduleRule = new events.Rule(this, 'IdleScanSchedule', {
      description: 'Triggers idle-reaper every 5 minutes for browser-pod activity check.',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.fn)],
    });

    // Cleanup-on-stop: ECS task transitions to STOPPED in the cluster.
    this.taskStateChangeRule = new events.Rule(this, 'TaskStateChangeRule', {
      description: 'Routes ECS task STOPPED events to idle-reaper for ALB cleanup.',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.cluster.clusterArn],
          lastStatus: ['STOPPED'],
        },
      },
      targets: [new targets.LambdaFunction(this.fn)],
    });

    new ssm.StringParameter(this, 'IdleReaperFnArnParam', {
      parameterName: ssmParamPath(config, 'idle-reaper/function-arn'),
      stringValue: this.fn.functionArn,
    });
    new ssm.StringParameter(this, 'IdleTopicArnParam', {
      parameterName: ssmParamPath(config, 'idle-reaper/topic-arn'),
      stringValue: this.idleTopic.topicArn,
    });

    NagSuppressions.addResourceSuppressions(
      this.fn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:GetMetricStatistics requires Resource: * per AWS API contract. lambda:InvokeFunction on `<pod-manager>:*` covers function versions/aliases — CDK\'s default grantInvoke pattern.',
          appliesTo: [
            'Resource::*',
            'Resource::<PodManagerFn2B3E342D.Arn>:*',
          ],
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.idleTopic,
      [
        {
          id: 'AwsSolutions-SNS2',
          reason:
            'SSE-KMS is not required for idle-warning notifications; messages contain only pod names + owner usernames (no secrets). Customer-managed KMS is a Phase 8+ polish item if regulated environments need it.',
        },
      ],
      true,
    );
  }
}
