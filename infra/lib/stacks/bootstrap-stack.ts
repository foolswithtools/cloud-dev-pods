import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import { ssmParamPath } from '../util/naming';

export interface BootstrapStackProps extends StackProps {
  config: Config;
}

/**
 * Account-level bootstrap. Run once per AWS account where cloud-dev-pods will be
 * deployed. Creates the GitHub OIDC trust, the two GitHub Actions roles, the
 * permissions boundary, and the ECR repos.
 *
 * After this stack exists, all other workflows authenticate via OIDC; no
 * long-lived AWS keys are needed.
 */
export class BootstrapStack extends Stack {
  public readonly deployerRole: iam.Role;
  public readonly podOpsRole: iam.Role;
  public readonly browserRepo: ecr.Repository;
  public readonly tunnelRepo: ecr.Repository;
  public readonly boundary: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);
    const { config } = props;

    // 1. GitHub OIDC identity provider.
    const githubOidc = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // 2. Permissions boundary applied to both GitHub-assumed roles.
    // Keeps blast radius contained even if the role's policies grow.
    this.boundary = new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: 'CloudDevPodsBoundary',
      description: 'Permissions boundary for cloud-dev-pods GitHub Actions roles.',
      statements: [
        // Allow most actions; the role's own policies decide what's actually used.
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['*'],
          resources: ['*'],
        }),
        // Hard deny on actions that would let a compromised role escape the project.
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [
            'iam:CreateUser',
            'iam:CreateAccessKey',
            'iam:DeleteUser',
            'organizations:*',
            'account:*',
            'aws-portal:*',
            'budgets:*',
          ],
          resources: ['*'],
        }),
        // Lock IAM role manipulation to the project's path.
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [
            'iam:CreateRole',
            'iam:DeleteRole',
            'iam:UpdateRole',
            'iam:AttachRolePolicy',
            'iam:DetachRolePolicy',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
          ],
          notResources: [`arn:aws:iam::${config.aws.accountId}:role/cloud-dev-pods/*`],
        }),
      ],
    });

    const subClaims = [
      `repo:${config.github.org}/${config.github.repo}:ref:refs/heads/main`,
      `repo:${config.github.org}/${config.github.repo}:environment:prod`,
    ];

    const principal = new iam.OpenIdConnectPrincipal(githubOidc, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': subClaims,
      },
    });

    // 3. Deployer role: used by cluster-up/down and bootstrap workflows.
    this.deployerRole = new iam.Role(this, 'DeployerRole', {
      roleName: 'CloudDevPodsDeployerRole',
      path: '/cloud-dev-pods/',
      assumedBy: principal,
      permissionsBoundary: this.boundary,
      description: 'GitHub Actions OIDC role for `cdk deploy` operations.',
    });

    // PowerUserAccess covers most CDK deploy needs; bounded by the policy above.
    // Phase 4 polish: replace with a tighter inline policy enumerating only the
    // services we actually deploy.
    this.deployerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
    );
    // PowerUserAccess does not include IAM; CDK needs IAM to manage roles.
    this.deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:*'],
        resources: ['*'],
      }),
    );

    // 4. Pod-ops role: used by pod-up/down/list and build-runtime workflows.
    // Only `lambda:InvokeFunction` on pod-manager and ECR push to project repos.
    this.podOpsRole = new iam.Role(this, 'PodOpsRole', {
      roleName: 'CloudDevPodsPodOpsRole',
      path: '/cloud-dev-pods/',
      assumedBy: principal,
      permissionsBoundary: this.boundary,
      description: 'GitHub Actions OIDC role for pod lifecycle ops + ECR push.',
    });

    this.podOpsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${config.aws.region}:${config.aws.accountId}:function:pod-manager`,
        ],
      }),
    );
    // ECR auth token must be on `*` per AWS API contract.
    this.podOpsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    this.podOpsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        resources: [
          `arn:aws:ecr:${config.aws.region}:${config.aws.accountId}:repository/cloud-dev-pods/*`,
        ],
      }),
    );
    this.podOpsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents', 'logs:GetLogEvents'],
        resources: [
          `arn:aws:logs:${config.aws.region}:${config.aws.accountId}:log-group:/cloud-dev-pods/*`,
        ],
      }),
    );

    // 5. ECR repositories.
    this.browserRepo = new ecr.Repository(this, 'BrowserRepo', {
      repositoryName: 'cloud-dev-pods/vscode-browser',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    });
    this.tunnelRepo = new ecr.Repository(this, 'TunnelRepo', {
      repositoryName: 'cloud-dev-pods/vscode-tunnel',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    });

    // 6. SSM outputs (avoid CFN cross-stack exports — see ADR 0006).
    new ssm.StringParameter(this, 'DeployerRoleArnParam', {
      parameterName: ssmParamPath(config, 'bootstrap/deployer-role-arn'),
      stringValue: this.deployerRole.roleArn,
    });
    new ssm.StringParameter(this, 'PodOpsRoleArnParam', {
      parameterName: ssmParamPath(config, 'bootstrap/pod-ops-role-arn'),
      stringValue: this.podOpsRole.roleArn,
    });
    new ssm.StringParameter(this, 'BrowserRepoUriParam', {
      parameterName: ssmParamPath(config, 'bootstrap/ecr/vscode-browser-uri'),
      stringValue: this.browserRepo.repositoryUri,
    });
    new ssm.StringParameter(this, 'TunnelRepoUriParam', {
      parameterName: ssmParamPath(config, 'bootstrap/ecr/vscode-tunnel-uri'),
      stringValue: this.tunnelRepo.repositoryUri,
    });

    // 7. cdk-nag suppressions, each with a justification.
    NagSuppressions.addResourceSuppressions(
      this.deployerRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'PowerUserAccess is intentional for CDK deploy. Bounded by CloudDevPodsBoundary which restricts IAM to /cloud-dev-pods/ paths and denies user/account-level actions.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'iam:* on * is required so CDK can create/update task roles, lambda execution roles, etc. Bounded by CloudDevPodsBoundary.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.podOpsRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken requires Resource: *; this is an AWS API contract limitation, not a policy gap.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.boundary,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'A permissions boundary by design uses Allow `*` on `*`; the actual restriction comes from the explicit deny statements on user/account/IAM-path actions.',
        },
      ],
      true,
    );
  }
}
