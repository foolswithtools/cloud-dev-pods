import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { acknowledgeNag, nagImportRef } from '../util/nag';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';
import type { ClusterStack } from './cluster-stack';

export interface PodTaskFamilyStackProps extends StackProps {
  config: Config;
  cluster: ClusterStack;
}

/**
 * Two reusable Fargate task definition families: browser and tunnel.
 *
 * The CDK-defined revisions use a placeholder image tag that the pod-manager
 * Lambda overrides by registering a fresh task-definition revision per pod-up
 * (ECR repos are IMMUTABLE, so we can't just push :latest; pod-manager
 * resolves the latest pushed SHA via `ecr:DescribeImages`).
 *
 * The IAM roles below are reused across all revisions in the family.
 */
export class PodTaskFamilyStack extends Stack {
  public readonly browserTaskDef: ecs.FargateTaskDefinition;
  public readonly tunnelTaskDef: ecs.FargateTaskDefinition;
  public readonly executionRole: iam.Role;
  public readonly browserTaskRole: iam.Role;
  public readonly tunnelTaskRole: iam.Role;

  constructor(scope: Construct, id: string, props: PodTaskFamilyStackProps) {
    super(scope, id, props);
    const { config, cluster } = props;

    // Secrets pre-created by BootstrapStack (Phase 9.5) with placeholder
    // values; init-clone.ts (Phase 12) populates client-id/client-secret with
    // the user's GitHub OAuth App credentials. cookie-secret is auto-generated.
    const oauthClientId = secretsmanager.Secret.fromSecretNameV2(
      this,
      'OAuthClientIdRef',
      '/cloud-dev-pods/oauth/client-id',
    );
    const oauthClientSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'OAuthClientSecretRef',
      '/cloud-dev-pods/oauth/client-secret',
    );
    const oauthCookieSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'OAuthCookieSecretRef',
      '/cloud-dev-pods/oauth/cookie-secret',
    );

    const browserRepo = ecr.Repository.fromRepositoryName(
      this,
      'BrowserRepoRef',
      'cloud-dev-pods/vscode-browser',
    );
    const tunnelRepo = ecr.Repository.fromRepositoryName(
      this,
      'TunnelRepoRef',
      'cloud-dev-pods/vscode-tunnel',
    );

    // Single execution role (pulls images, writes logs, reads secrets).
    // Reused by both task definitions.
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'CloudDevPodsTaskExecutionRole',
      path: '/cloud-dev-pods/',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls runtime images from ECR, writes pod logs, reads oauth secrets.',
    });
    this.executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
    );
    oauthClientId.grantRead(this.executionRole);
    oauthClientSecret.grantRead(this.executionRole);
    oauthCookieSecret.grantRead(this.executionRole);

    // Per-mode task role: scopes runtime AWS access for the pod itself.
    // Browser pods only need EFS + minimal logs; tunnel pods same.
    const taskRolePolicyDoc = (modeName: string) =>
      new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [
              `arn:aws:logs:${config.aws.region}:${config.aws.accountId}:log-group:${cluster.podsLogGroup.logGroupName}:log-stream:${modeName}/*`,
            ],
          }),
        ],
      });
    this.browserTaskRole = new iam.Role(this, 'BrowserTaskRole', {
      roleName: 'CloudDevPodsBrowserTaskRole',
      path: '/cloud-dev-pods/',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pod task role for browser-mode pods.',
      inlinePolicies: { default: taskRolePolicyDoc('browser') },
    });
    this.tunnelTaskRole = new iam.Role(this, 'TunnelTaskRole', {
      roleName: 'CloudDevPodsTunnelTaskRole',
      path: '/cloud-dev-pods/',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pod task role for tunnel-mode pods.',
      inlinePolicies: { default: taskRolePolicyDoc('tunnel') },
    });
    // Per-pod log streams need a wildcard suffix; the pod name is part of
    // the stream path. Bounded to this log group + mode-specific prefix.
    acknowledgeNag(
      [this.browserTaskRole, this.tunnelTaskRole],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Per-pod CloudWatch log streams are wildcarded by pod name. Bounded to the cluster pods log group and the mode-specific stream prefix (browser/* or tunnel/*).',
          appliesTo: ['browser', 'tunnel'].map(
            (modeName) =>
              `Resource::arn:aws:logs:${config.aws.region}:${config.aws.accountId}:log-group:${nagImportRef(cluster, 'ExportsOutputRefPodsLogGroup17520DC50F223430')}:log-stream:${modeName}/*`,
          ),
        },
      ],
    );

    // EFS volume reference, attached to both task families. Per-pod access
    // points are created at runtime by pod-manager (ADR 0004); the access-point
    // ID gets attached via container-level mountPoints when a fresh task-def
    // revision is registered per pod-up.
    const efsVolume: ecs.Volume = {
      name: 'workspace',
      efsVolumeConfiguration: {
        fileSystemId: cluster.fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        // No per-AP rootDirectory here — pod-manager fills authorizationConfig
        // with the correct accessPointId when registering each pod's revision.
      },
    };

    // Browser: openvscode-server only. The image URI below is a placeholder.
    // This revision is never run: pod-manager registers a fresh revision per
    // pod-up with the resolved-by-SHA image plus the oauth2-proxy sidecar
    // (ALB target), built by infra/lambda/pod-manager/oauth2-proxy.ts. Only
    // the family name is consumed (PodManagerStack's BROWSER_TASK_DEF_FAMILY).
    this.browserTaskDef = new ecs.FargateTaskDefinition(this, 'BrowserTaskDef', {
      family: 'cloud-dev-pods-browser',
      cpu: config.pods.defaultCpu,
      memoryLimitMiB: config.pods.defaultMemory,
      executionRole: this.executionRole,
      taskRole: this.browserTaskRole,
      volumes: [efsVolume],
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const browserVscode = this.browserTaskDef.addContainer('vscode', {
      containerName: 'vscode',
      image: ecs.ContainerImage.fromEcrRepository(browserRepo, 'replaced-by-pod-manager'),
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: cluster.podsLogGroup,
        streamPrefix: 'browser/vscode',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:3000/ >/dev/null || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(20),
      },
    });
    browserVscode.addMountPoints({
      sourceVolume: 'workspace',
      containerPath: '/workspace',
      readOnly: false,
    });

    // Tunnel: single container; no oauth2-proxy, no ALB target.
    this.tunnelTaskDef = new ecs.FargateTaskDefinition(this, 'TunnelTaskDef', {
      family: 'cloud-dev-pods-tunnel',
      cpu: config.pods.defaultCpu,
      memoryLimitMiB: config.pods.defaultMemory,
      executionRole: this.executionRole,
      taskRole: this.tunnelTaskRole,
      volumes: [efsVolume],
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const tunnelVscode = this.tunnelTaskDef.addContainer('vscode-tunnel', {
      containerName: 'vscode-tunnel',
      image: ecs.ContainerImage.fromEcrRepository(tunnelRepo, 'replaced-by-pod-manager'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: cluster.podsLogGroup,
        streamPrefix: 'tunnel/vscode-tunnel',
      }),
      // Time for the entrypoint's SIGTERM trap to run `code tunnel unregister`.
      stopTimeout: Duration.seconds(30),
      // POD_NAME is supplied by pod-manager at RunTask time as a containerOverride.
    });
    tunnelVscode.addMountPoints({
      sourceVolume: 'workspace',
      containerPath: '/workspace',
      readOnly: false,
    });

    new ssm.StringParameter(this, 'BrowserTaskDefArnParam', {
      parameterName: ssmParamPath(config, 'pod-task-family/browser-arn'),
      stringValue: this.browserTaskDef.taskDefinitionArn,
    });
    new ssm.StringParameter(this, 'TunnelTaskDefArnParam', {
      parameterName: ssmParamPath(config, 'pod-task-family/tunnel-arn'),
      stringValue: this.tunnelTaskDef.taskDefinitionArn,
    });
    new ssm.StringParameter(this, 'BrowserTaskRoleArnParam', {
      parameterName: ssmParamPath(config, 'pod-task-family/browser-task-role-arn'),
      stringValue: this.browserTaskRole.roleArn,
    });
    new ssm.StringParameter(this, 'TunnelTaskRoleArnParam', {
      parameterName: ssmParamPath(config, 'pod-task-family/tunnel-task-role-arn'),
      stringValue: this.tunnelTaskRole.roleArn,
    });
    new ssm.StringParameter(this, 'ExecutionRoleArnParam', {
      parameterName: ssmParamPath(config, 'pod-task-family/execution-role-arn'),
      stringValue: this.executionRole.roleArn,
    });

    acknowledgeNag(
      this.executionRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AmazonECSTaskExecutionRolePolicy is the AWS-recommended baseline for pulling images and writing logs; we layer Secrets Manager grants on top for oauth2-proxy creds.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcards come from the AWS-managed AmazonECSTaskExecutionRolePolicy and from Secrets Manager grants that key on /cloud-dev-pods/oauth/*. Both are required for ECS task launch.',
          appliesTo: [
            'Resource::*',
            'Action::ecr:*',
            'Action::logs:*',
          ],
        },
      ],
    );
  }
}
