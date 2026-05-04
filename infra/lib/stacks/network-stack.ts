import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';

export interface NetworkStackProps extends StackProps {
  config: Config;
}

/**
 * VPC, subnets, NAT, security groups, and (optional) VPC endpoints.
 *
 * Three security groups, one per tier, with explicit ingress chains:
 *   sg-alb     :443/:80 from world
 *   sg-tasks   :4180   from sg-alb (oauth2-proxy port)
 *   sg-efs     :2049   from sg-tasks (NFS)
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly tasksSg: ec2.SecurityGroup;
  public readonly efsSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Flow logs go to a dedicated CW log group; REJECT-only to keep volume low.
    // DESTROY so cluster-down → cluster-up cycles don't fail on a stale group.
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/cloud-dev-pods/${config.project.env}/vpc-flow-logs`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.network.vpcCidr),
      maxAzs: 2,
      natGateways: config.network.natGateways,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
      flowLogs: {
        Reject: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    if (config.network.useVpcEndpoints) {
      this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
      });
      this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      });
      this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      });
      this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      });
    }

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB ingress from world on 80/443.',
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from world');
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP for redirect');

    this.tasksSg = new ec2.SecurityGroup(this, 'TasksSg', {
      vpc: this.vpc,
      description: 'ECS tasks: oauth2-proxy port 4180 from sg-alb only.',
      allowAllOutbound: true,
    });
    this.tasksSg.addIngressRule(this.albSg, ec2.Port.tcp(4180), 'oauth2-proxy from ALB');

    this.efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      description: 'EFS mount targets: NFS port 2049 from sg-tasks only.',
      allowAllOutbound: false,
    });
    this.efsSg.addIngressRule(this.tasksSg, ec2.Port.tcp(2049), 'NFS from tasks');

    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: ssmParamPath(config, 'network/vpc-id'),
      stringValue: this.vpc.vpcId,
    });
    new ssm.StringParameter(this, 'AlbSgIdParam', {
      parameterName: ssmParamPath(config, 'network/alb-sg-id'),
      stringValue: this.albSg.securityGroupId,
    });
    new ssm.StringParameter(this, 'TasksSgIdParam', {
      parameterName: ssmParamPath(config, 'network/tasks-sg-id'),
      stringValue: this.tasksSg.securityGroupId,
    });
    new ssm.StringParameter(this, 'EfsSgIdParam', {
      parameterName: ssmParamPath(config, 'network/efs-sg-id'),
      stringValue: this.efsSg.securityGroupId,
    });

    NagSuppressions.addResourceSuppressions(
      this.albSg,
      [
        {
          id: 'AwsSolutions-EC23',
          reason:
            'ALB is internet-facing by design; pod URLs must be reachable. Auth is enforced at oauth2-proxy on the task side, not at the SG.',
        },
      ],
      true,
    );
  }
}
