import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  guardWorkspaces,
  parseGuardArgs,
  writeGuardOutputs,
  type AccessPointInfo,
  type GuardCalls,
  type GuardResult,
  type StackResource,
} from './cluster-workspace-guard.js';

const STACK = 'CloudDevPods-Cluster';
const FS_ID = 'fs-0123456789abcdef0';

/** A deployed Cluster stack template with one EFS file system. */
function template(deletionPolicy: string | undefined): string {
  const fs: Record<string, unknown> = { Type: 'AWS::EFS::FileSystem', Properties: {} };
  if (deletionPolicy !== undefined) {
    fs.DeletionPolicy = deletionPolicy;
    fs.UpdateReplacePolicy = deletionPolicy;
  }
  return JSON.stringify({
    Resources: {
      EfsFsABCD1234: fs,
      EfsIdParam5678: { Type: 'AWS::SSM::Parameter', Properties: {} },
    },
  });
}

const RESOURCES: StackResource[] = [
  { logicalId: 'EfsFsABCD1234', type: 'AWS::EFS::FileSystem', physicalId: FS_ID, status: 'CREATE_COMPLETE' },
  { logicalId: 'EfsIdParam5678', type: 'AWS::SSM::Parameter', physicalId: '/cloud-dev-pods/dev/cluster/efs-id', status: 'CREATE_COMPLETE' },
];

const AP = (pod: string, n: number): AccessPointInfo => ({
  accessPointId: `fsap-${n}`,
  pod,
  path: `/pods/${pod}-abcd`,
});

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const STACK_GONE = named('ValidationError', `Stack with id ${STACK} does not exist`);

interface Fake {
  template?: string | Error;
  resources?: StackResource[] | Error;
  accessPoints?: AccessPointInfo[] | Error;
}

// Fake AWS calls: each answers from the scenario and records that it was
// called. No AWS, no mocking library.
function fakeCalls(f: Fake) {
  const called: string[] = [];
  const answer = <T>(name: string, v: T | Error | undefined): Promise<T> => {
    called.push(name);
    if (v === undefined) return Promise.reject(new Error(`fakeCalls: unexpected ${name}`));
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  const calls: GuardCalls = {
    getTemplateBody: (s) => {
      expect(s).toBe(STACK);
      return answer('getTemplateBody', f.template);
    },
    listStackResources: (s) => {
      expect(s).toBe(STACK);
      return answer('listStackResources', f.resources);
    },
    describeAccessPoints: (id) => {
      expect(id).toBe(FS_ID);
      return answer('describeAccessPoints', f.accessPoints);
    },
  };
  return { calls, called };
}

async function run(f: Fake, opts: { deleteWorkspaces?: boolean; configRetain?: boolean } = {}) {
  const { calls, called } = fakeCalls(f);
  const lines: string[] = [];
  const result = await guardWorkspaces({
    stackName: STACK,
    configRetain: opts.configRetain ?? false,
    deleteWorkspaces: opts.deleteWorkspaces ?? false,
    calls,
    log: (l) => lines.push(l),
  });
  return { result, called, lines };
}

describe('guardWorkspaces', () => {
  it('proceeds when the deployed policy is RETAIN, without listing access points', async () => {
    const { result, called } = await run(
      { template: template('Retain'), resources: RESOURCES },
      { configRetain: true },
    );
    expect(result.proceed).toBe(true);
    expect(result.efs).toEqual({ action: 'retain', fileSystemId: FS_ID, workspaces: [] });
    expect(called).not.toContain('describeAccessPoints');
  });

  it('proceeds when DESTROY and the file system has no access points', async () => {
    const { result } = await run({ template: template('Delete'), resources: RESOURCES, accessPoints: [] });
    expect(result.proceed).toBe(true);
    expect(result.efs).toEqual({ action: 'destroy', fileSystemId: FS_ID, workspaces: [] });
  });

  it('treats a missing DeletionPolicy as DESTROY (the CloudFormation default)', async () => {
    const { result } = await run({ template: template(undefined), resources: RESOURCES, accessPoints: [AP('alpha', 1)] });
    expect(result.proceed).toBe(false);
  });

  it('proceeds when DESTROY with access points and delete_workspaces confirmed', async () => {
    const { result } = await run(
      { template: template('Delete'), resources: RESOURCES, accessPoints: [AP('alpha', 1), AP('beta', 2)] },
      { deleteWorkspaces: true },
    );
    expect(result.proceed).toBe(true);
    expect(result.efs).toEqual({ action: 'destroy', fileSystemId: FS_ID, workspaces: ['alpha', 'beta'] });
    expect(result.reason).toContain('delete_workspaces');
  });

  it('refuses DESTROY with access points and no confirmation, with all three ways out', async () => {
    const { result } = await run({
      template: template('Delete'),
      resources: RESOURCES,
      accessPoints: [AP('alpha', 1), AP('beta', 2)],
    });
    expect(result.proceed).toBe(false);
    expect(result.efs.workspaces).toEqual(['alpha', 'beta']);
    expect(result.reason).toContain(FS_ID);
    expect(result.reason).toContain('alpha');
    expect(result.reason).toContain('beta');
    // Delete on purpose.
    expect(result.reason).toContain('delete_workspaces=true');
    // Keep: flip retention and re-run cluster-up, which updates the removal policy.
    expect(result.reason).toContain('efs.retainOnClusterDown: true');
    expect(result.reason).toContain('cluster-up');
    // Or back up first.
    expect(result.reason).toMatch(/back (them )?up/i);
  });

  it('names the config/deployed mismatch when config says retain but the stack still says DESTROY', async () => {
    const { result } = await run(
      { template: template('Delete'), resources: RESOURCES, accessPoints: [AP('alpha', 1)] },
      { configRetain: true },
    );
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/config\/config\.yaml sets efs\.retainOnClusterDown: true/);
    expect(result.reason).toContain('cluster-up');
  });

  it('labels a workspace by access point ID when it has no Pod tag', async () => {
    const { result } = await run({
      template: template('Delete'),
      resources: RESOURCES,
      accessPoints: [{ accessPointId: 'fsap-9', path: '/pods/x-1' }],
    });
    expect(result.efs.workspaces).toEqual(['fsap-9 (/pods/x-1)']);
  });

  describe('file system not found', () => {
    it('proceeds when the Cluster stack no longer exists', async () => {
      const { result, called } = await run({ template: STACK_GONE });
      expect(result.proceed).toBe(true);
      expect(result.efs).toEqual({ action: 'absent', workspaces: [] });
      expect(called).toEqual(['getTemplateBody']);
    });

    it('proceeds when the stack has no EFS file system resource', async () => {
      const { result } = await run({
        template: JSON.stringify({ Resources: { X: { Type: 'AWS::SSM::Parameter' } } }),
        resources: [],
      });
      expect(result.proceed).toBe(true);
      expect(result.efs.action).toBe('absent');
    });

    it('proceeds when the EFS resource is already DELETE_COMPLETE', async () => {
      const { result } = await run({
        template: template('Delete'),
        resources: [{ ...RESOURCES[0]!, status: 'DELETE_COMPLETE' }],
      });
      expect(result.proceed).toBe(true);
      expect(result.efs.action).toBe('absent');
    });

    it('proceeds when EFS says the file system is gone', async () => {
      const { result } = await run({
        template: template('Delete'),
        resources: RESOURCES,
        accessPoints: named('FileSystemNotFound', `File system '${FS_ID}' does not exist.`),
      });
      expect(result.proceed).toBe(true);
      expect(result.efs).toEqual({ action: 'absent', fileSystemId: FS_ID, workspaces: [] });
    });
  });

  describe('fails closed on any other error', () => {
    const cases: { name: string; fake: Fake }[] = [
      { name: 'GetTemplate AccessDenied', fake: { template: named('AccessDenied', 'not authorized') } },
      { name: 'unparseable template', fake: { template: 'Resources:\n  X: y\n' } },
      {
        name: 'ListStackResources throttled',
        fake: { template: template('Delete'), resources: named('Throttling', 'Rate exceeded') },
      },
      {
        name: 'DescribeAccessPoints AccessDenied',
        fake: { template: template('Delete'), resources: RESOURCES, accessPoints: named('AccessDeniedException', 'nope') },
      },
    ];
    for (const c of cases) {
      it(`refuses on ${c.name}`, async () => {
        const { result } = await run(c.fake);
        expect(result.proceed).toBe(false);
        expect(result.reason).toContain('delete_workspaces=true');
      });

      it(`proceeds on ${c.name} when delete_workspaces is confirmed`, async () => {
        const { result } = await run(c.fake, { deleteWorkspaces: true });
        expect(result.proceed).toBe(true);
        expect(result.efs.action).toBe('destroy');
      });
    }
  });
});

describe('parseGuardArgs', () => {
  it('accepts no flags and --delete-workspaces', () => {
    expect(parseGuardArgs([])).toEqual({ deleteWorkspaces: false });
    expect(parseGuardArgs(['--delete-workspaces'])).toEqual({ deleteWorkspaces: true });
  });

  it('refuses anything else', () => {
    expect(parseGuardArgs(['--force'])).toHaveProperty('error');
    expect(parseGuardArgs(['yes'])).toHaveProperty('error');
  });
});

describe('writeGuardOutputs', () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'guard-output-')));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const result = (proceed: boolean, efs: GuardResult['efs']): GuardResult => ({ proceed, reason: 'r', efs });

  it('writes proceed, efs_action and efs_id when the guard proceeds', () => {
    const out = join(dir, 'retain');
    writeGuardOutputs(result(true, { action: 'retain', fileSystemId: FS_ID, workspaces: [] }), out);
    expect(readFileSync(out, 'utf8')).toBe(`efs_action=retain\nefs_id=${FS_ID}\nproceed=true\n`);
  });

  it('writes an empty efs_id when there is no file system', () => {
    const out = join(dir, 'absent');
    writeGuardOutputs(result(true, { action: 'absent', workspaces: [] }), out);
    expect(readFileSync(out, 'utf8')).toBe('efs_action=absent\nefs_id=\nproceed=true\n');
  });

  it('writes nothing when the guard refused', () => {
    const out = join(dir, 'refused');
    writeGuardOutputs(result(false, { action: 'destroy', fileSystemId: FS_ID, workspaces: ['a'] }), out);
    expect(existsSync(out)).toBe(false);
  });

  it('does nothing when no output path is set', () => {
    expect(() => writeGuardOutputs(result(true, { action: 'absent', workspaces: [] }), undefined)).not.toThrow();
  });
});

describe('cluster-workspace-guard CLI', () => {
  const SCRIPT = resolve(import.meta.dirname, 'cluster-workspace-guard.ts');

  it('rejects an unknown flag with usage before any AWS call', { timeout: 60_000 }, () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--bogus'], {
      env: {
        PATH: process.env.PATH,
        AWS_REGION: 'us-west-2',
        AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: cluster-workspace-guard [--delete-workspaces]');
    expect(r.stderr).toContain('--bogus');
    expect(r.stdout).toBe('');
  });
});

// End-to-end: run the real script through a symlinked repo root (the #194
// shape) against a fake CloudFormation and EFS on localhost. Checks that the
// real SDK's error shapes match what the guard classifies. Nothing reaches AWS.
describe('cluster-workspace-guard CLI (symlinked path, fake AWS)', () => {
  const repoRoot = resolve(import.meta.dirname, '..');
  let tmp: string;
  let linkRoot: string;
  let configPath: string;
  let server: Server;
  let port: number;
  // CloudFormation is awsQuery (form-encoded POST to /); EFS is REST-JSON.
  let cfn: (action: string) => { status: number; body: string };
  let efsAccessPoints: unknown[] = [];

  const xml = (action: string, inner: string) =>
    `<${action}Response xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><${action}Result>${inner}</${action}Result></${action}Response>`;
  const cfnError = (code: string, message: string) => ({
    status: 400,
    body: `<ErrorResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>r</RequestId></ErrorResponse>`,
  });
  const deployed = (deletionPolicy: string) => (action: string) => {
    if (action === 'GetTemplate') {
      const body = template(deletionPolicy).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      return { status: 200, body: xml(action, `<TemplateBody>${body}</TemplateBody>`) };
    }
    return {
      status: 200,
      body: xml(
        action,
        `<StackResourceSummaries><member><LogicalResourceId>EfsFsABCD1234</LogicalResourceId><PhysicalResourceId>${FS_ID}</PhysicalResourceId><ResourceType>AWS::EFS::FileSystem</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus><LastUpdatedTimestamp>2026-01-01T00:00:00Z</LastUpdatedTimestamp></member></StackResourceSummaries>`,
      ),
    };
  };

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'guard-cli-')));
    linkRoot = join(tmp, 'repo');
    symlinkSync(repoRoot, linkRoot, 'dir');
    configPath = join(tmp, 'config.yaml');
    writeFileSync(configPath, readFileSync(join(repoRoot, 'config', 'config.example.yaml'), 'utf8'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/') {
          const r = cfn(new URLSearchParams(body).get('Action') ?? '');
          res.writeHead(r.status, { 'content-type': 'text/xml' });
          res.end(r.body);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ AccessPoints: efsAccessPoints }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Unlink the repo-root symlink before removing the dir, so rmSync can never recurse into the checkout.
    try {
      unlinkSync(linkRoot);
    } catch {
      // already gone
    }
    rmSync(tmp, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  });

  // Async spawn (not spawnSync): the fake AWS lives in this process's event loop.
  function runCli(outputFile: string, args: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    return new Promise((done, fail) => {
      const child = spawn(tsx, [join(linkRoot, 'scripts', 'cluster-workspace-guard.ts'), ...args], {
        env: {
          PATH: process.env.PATH,
          AWS_REGION: 'us-west-2',
          AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`,
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          AWS_EC2_METADATA_DISABLED: 'true',
          CDPODS_CONFIG: configPath,
          GITHUB_OUTPUT: outputFile,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', fail);
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
  }

  it('proceeds and writes the marker when the Cluster stack does not exist', { timeout: 60_000 }, async () => {
    cfn = () => cfnError('ValidationError', `Stack with id ${STACK} does not exist`);
    const out = join(tmp, 'output-gone');
    const r = await runCli(out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('efs_action=absent\nefs_id=\nproceed=true\n');
  });

  it('refuses with no marker when DESTROY and a pod workspace exists', { timeout: 60_000 }, async () => {
    cfn = deployed('Delete');
    efsAccessPoints = [
      { AccessPointId: 'fsap-1', FileSystemId: FS_ID, Tags: [{ Key: 'Pod', Value: 'alpha' }], RootDirectory: { Path: '/pods/alpha-1' } },
    ];
    const out = join(tmp, 'output-refused');
    const r = await runCli(out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('alpha');
    expect(r.stderr).toContain('delete_workspaces=true');
    expect(existsSync(out)).toBe(false);
  });

  it('proceeds with --delete-workspaces', { timeout: 60_000 }, async () => {
    cfn = deployed('Delete');
    const out = join(tmp, 'output-confirmed');
    const r = await runCli(out, ['--delete-workspaces']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(`efs_action=destroy\nefs_id=${FS_ID}\nproceed=true\n`);
  });

  it('proceeds when the deployed policy is RETAIN', { timeout: 60_000 }, async () => {
    cfn = deployed('Retain');
    const out = join(tmp, 'output-retain');
    const r = await runCli(out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(`efs_action=retain\nefs_id=${FS_ID}\nproceed=true\n`);
  });

  it('fails closed on AccessDenied from CloudFormation', { timeout: 60_000 }, async () => {
    cfn = () => cfnError('AccessDenied', 'not authorized to perform cloudformation:GetTemplate');
    const out = join(tmp, 'output-denied');
    const r = await runCli(out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not authorized');
    expect(existsSync(out)).toBe(false);
  });
});
