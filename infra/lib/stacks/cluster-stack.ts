import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';
import type { NetworkStack } from './network-stack';

export interface ClusterStackProps extends StackProps {
  config: Config;
  network: NetworkStack;
}

/**
 * Cluster-level shared infrastructure: ECS cluster, EFS, ALB, listener, log groups.
 *
 * Pods are NOT defined here; that's `PodTaskFamilyStack` + `PodManagerStack` (Phase 7).
 * This stack produces the surfaces those stacks plug into.
 */
export class ClusterStack extends Stack {
  public readonly cluster: ecs.Cluster;
  public readonly fileSystem: efs.FileSystem;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** Primary listener pods register against. HTTPS when `domain.strategy = byo`, HTTP otherwise. */
  public readonly listener: elbv2.ApplicationListener;
  public readonly listenerProtocol: 'HTTP' | 'HTTPS';
  public readonly clusterLogGroup: logs.LogGroup;
  public readonly podsLogGroup: logs.LogGroup;
  public readonly hostedZone?: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);
    const { config, network } = props;

    // ECS cluster with Fargate + Fargate Spot.
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      clusterName: 'cloud-dev-pods',
      enableFargateCapacityProviders: true,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // EFS filesystem. Per-pod access points (see ADR 0004) live in the
    // pod-manager Lambda, not here.
    //
    // RemovalPolicy is flag-driven (see ADR 0007). Default DESTROY: an
    // explicit `cluster-down` tears the filesystem down with the cluster,
    // avoiding orphan filesystems and the name-collision footgun on the
    // next `cluster-up`. Flip `efs.retainOnClusterDown: true` in the
    // config to restore the v0.1.x RETAIN behavior for forks hosting
    // data they truly cannot afford to lose on an explicit teardown.
    this.fileSystem = new efs.FileSystem(this, 'EfsFs', {
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: network.efsSg,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: config.efs?.retainOnClusterDown
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });

    // ALB (internet-facing). Per-pod target groups + listener rules added at runtime.
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSg,
      idleTimeout: Duration.seconds(120),
    });

    // Default 404 fixed response — surfaces clear errors when a host doesn't match a pod.
    const default404 = elbv2.ListenerAction.fixedResponse(404, {
      contentType: 'text/plain',
      messageBody: 'No pod registered for this hostname.',
    });

    if (config.domain.strategy === 'byo') {
      if (!config.domain.baseDomain || !config.domain.hostedZoneId) {
        throw new Error(
          'config.domain.baseDomain and config.domain.hostedZoneId are required when domain.strategy = "byo".',
        );
      }

      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.domain.hostedZoneId,
        zoneName: config.domain.baseDomain,
      });

      const certificate = new acm.Certificate(this, 'WildcardCert', {
        domainName: `*.${config.domain.baseDomain}`,
        validation: acm.CertificateValidation.fromDns(this.hostedZone),
      });

      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      this.listener = this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: default404,
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      });
      this.listenerProtocol = 'HTTPS';

      new route53.ARecord(this, 'WildcardAlias', {
        zone: this.hostedZone,
        recordName: '*',
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.alb)),
      });
    } else {
      // alb-default: HTTP-only. Documented as non-prod / development use only.
      this.listener = this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: default404,
      });
      this.listenerProtocol = 'HTTP';
    }

    this.clusterLogGroup = new logs.LogGroup(this, 'ClusterLogGroup', {
      logGroupName: `/cloud-dev-pods/${config.project.env}/cluster`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.podsLogGroup = new logs.LogGroup(this, 'PodsLogGroup', {
      logGroupName: `/cloud-dev-pods/${config.project.env}/pods`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // SSM outputs for downstream stacks + workflows to consume.
    new ssm.StringParameter(this, 'ClusterArnParam', {
      parameterName: ssmParamPath(config, 'cluster/cluster-arn'),
      stringValue: this.cluster.clusterArn,
    });
    new ssm.StringParameter(this, 'ClusterNameParam', {
      parameterName: ssmParamPath(config, 'cluster/cluster-name'),
      stringValue: this.cluster.clusterName,
    });
    new ssm.StringParameter(this, 'AlbArnParam', {
      parameterName: ssmParamPath(config, 'cluster/alb-arn'),
      stringValue: this.alb.loadBalancerArn,
    });
    new ssm.StringParameter(this, 'AlbDnsParam', {
      parameterName: ssmParamPath(config, 'cluster/alb-dns'),
      stringValue: this.alb.loadBalancerDnsName,
    });
    new ssm.StringParameter(this, 'ListenerArnParam', {
      parameterName: ssmParamPath(config, 'cluster/listener-arn'),
      stringValue: this.listener.listenerArn,
    });
    new ssm.StringParameter(this, 'ListenerProtocolParam', {
      parameterName: ssmParamPath(config, 'cluster/listener-protocol'),
      stringValue: this.listenerProtocol,
    });
    new ssm.StringParameter(this, 'EfsIdParam', {
      parameterName: ssmParamPath(config, 'cluster/efs-id'),
      stringValue: this.fileSystem.fileSystemId,
    });
    new ssm.StringParameter(this, 'PodsLogGroupParam', {
      parameterName: ssmParamPath(config, 'cluster/pods-log-group'),
      stringValue: this.podsLogGroup.logGroupName,
    });

    // cdk-nag suppressions.
    NagSuppressions.addResourceSuppressions(
      this.alb,
      [
        {
          id: 'AwsSolutions-ELB2',
          reason:
            'ALB access logs are intentionally off in v1 to avoid forcing every downstream user to provision an S3 bucket. Phase 6+ polish: opt-in flag in config.alb.accessLogs.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.fileSystem,
      [
        {
          id: 'AwsSolutions-EFS1',
          reason:
            'EFS uses an AWS-managed KMS key. CMK is appropriate for regulated environments; opt-in is a Phase 6+ polish item.',
        },
      ],
      true,
    );
  }
}
