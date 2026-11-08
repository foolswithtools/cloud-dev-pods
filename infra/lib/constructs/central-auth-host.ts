import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  CENTRAL_AUTH_HOST_LABEL,
  buildCentralAuthHostContainer,
  centralAuthHostName,
} from '../../lambda/pod-manager/oauth2-proxy';
import { CENTRAL_AUTH_HOST_RULE_PRIORITY } from '../../lambda/pod-manager/priority';
import type { AuthBrowser } from '../config/schema';
import { acknowledgeNag } from '../util/nag';

export interface CentralAuthHostProps {
  browser: AuthBrowser;
  baseDomain: string;
  region: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  // The tasks security group: it already admits the ALB on port 4180.
  securityGroup: ec2.ISecurityGroup;
  listener: elbv2.IApplicationListener;
  alb: elbv2.IApplicationLoadBalancer;
  hostedZone: route53.IHostedZone;
  logGroup: logs.ILogGroup;
}

/**
 * The central auth host (#144, ADR 0009): one always-on oauth2-proxy at
 * auth.<baseDomain>. It completes every OAuth callback and sets the session
 * cookie on .<baseDomain>; each pod sidecar then checks the owner on every
 * request. Only created when auth.browser.centralAuthHost is on.
 *
 * The container comes from buildCentralAuthHostContainer, the same builder
 * as the pod sidecars, so the shared cookie settings cannot drift. The three
 * /cloud-dev-pods/oauth/* secrets are granted to this task's execution role
 * only (ecs.Secret does that); its task role gets nothing. Anyone holding
 * the cookie secret can mint a session for any owner.
 */
export class CentralAuthHost extends Construct {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: CentralAuthHostProps) {
    super(scope, id);
    const hostName = centralAuthHostName(props.baseDomain);

    // ECS needs each secret's full ARN: a partial ARN whose name ends in
    // "-secret" is misread as one with a 6-character suffix and the task
    // fails with AccessDenied (docs/troubleshooting.md). BootstrapStack
    // creates the secrets but does not publish their ARNs, so look them up
    // at deploy time, as the Lambda's resolveSecretArn does at pod-up. The
    // lookup may describe the secrets, never read them.
    const SECRET_NAMES = {
      clientId: '/cloud-dev-pods/oauth/client-id',
      clientSecret: '/cloud-dev-pods/oauth/client-secret',
      cookieSecret: '/cloud-dev-pods/oauth/cookie-secret',
    } as const;
    const stack = Stack.of(this);
    const describePolicy = cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret'],
        resources: Object.values(SECRET_NAMES).map((name) =>
          stack.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${name}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
        ),
      }),
    ]);
    const lookup = (id: string, name: string) => {
      const call: cr.AwsSdkCall = {
        service: 'SecretsManager',
        action: 'describeSecret',
        parameters: { SecretId: name },
        physicalResourceId: cr.PhysicalResourceId.of(name),
        outputPaths: ['ARN'],
      };
      const res = new cr.AwsCustomResource(this, `${id}ArnLookup`, {
        onCreate: call,
        onUpdate: call,
        policy: describePolicy,
        installLatestAwsSdk: false,
      });
      return secretsmanager.Secret.fromSecretAttributes(this, `${id}Ref`, {
        secretCompleteArn: res.getResponseField('ARN'),
      });
    };
    const secrets = {
      clientId: lookup('OAuthClientId', SECRET_NAMES.clientId),
      clientSecret: lookup('OAuthClientSecret', SECRET_NAMES.clientSecret),
      cookieSecret: lookup('OAuthCookieSecret', SECRET_NAMES.cookieSecret),
    };
    const def = buildCentralAuthHostContainer(
      props.browser,
      {
        clientId: secrets.clientId.secretArn,
        clientSecret: secrets.clientSecret.secretArn,
        cookieSecret: secrets.cookieSecret.secretArn,
      },
      { baseDomain: props.baseDomain, logGroupName: props.logGroup.logGroupName, region: props.region },
    );
    const secretByArn = new Map(Object.values(secrets).map((s) => [s.secretArn, s]));

    // 0.25 vCPU, the Fargate minimum.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer(def.name!, {
      image: ecs.ContainerImage.fromRegistry(def.image!),
      essential: true,
      portMappings: (def.portMappings ?? []).map((p) => ({ containerPort: p.containerPort!, protocol: ecs.Protocol.TCP })),
      environment: Object.fromEntries((def.environment ?? []).map((e) => [e.name!, e.value!])),
      secrets: Object.fromEntries(
        (def.secrets ?? []).map((s) => {
          const secret = secretByArn.get(s.valueFrom!);
          if (!secret) throw new Error(`central auth host: no secret reference for ${s.name}`);
          return [s.name!, ecs.Secret.fromSecretsManager(secret)];
        }),
      ),
      // Streams are central-auth-host/oauth2-proxy/<task id>.
      logging: ecs.LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: 'central-auth-host' }),
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // A container that never gets healthy (bad issuer, placeholder
      // secrets) fails cluster-up instead of hanging it.
      circuitBreaker: { enable: true, rollback: true },
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 4180,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(30),
      healthCheck: { path: '/ping', healthyHttpCodes: '200', interval: Duration.seconds(15) },
    });
    targetGroup.addTarget(
      this.service.loadBalancerTarget({ containerName: def.name!, containerPort: 4180 }),
    );

    new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener: props.listener,
      priority: CENTRAL_AUTH_HOST_RULE_PRIORITY,
      conditions: [elbv2.ListenerCondition.hostHeaders([hostName])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // The wildcard record already resolves auth.<base>; an explicit record
    // keeps the central host reachable if the wildcard is ever narrowed.
    new route53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: CENTRAL_AUTH_HOST_LABEL,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb)),
    });

    // AwsCustomResource runs on one stack-level singleton Lambda.
    const provider = stack.node.tryFindChild(`AWS${cr.AwsCustomResource.PROVIDER_FUNCTION_UUID.replace(/-/g, '')}`);
    if (!provider) throw new Error('central auth host: AwsCustomResource provider function not found');
    acknowledgeNag(provider, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access. CDK attaches it to the AwsCustomResource provider that looks up the oauth secret ARNs (DescribeSecret only).',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ]);

    acknowledgeNag(taskDefinition, [
      {
        id: 'AwsSolutions-ECS2',
        reason:
          'Non-secret oauth2-proxy settings (provider, allowlist, cookie domain, redirect URL) are plain environment variables; the client id, client secret and cookie secret come from Secrets Manager.',
      },
    ]);
  }
}
