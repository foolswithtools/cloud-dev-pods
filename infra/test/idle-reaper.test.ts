// Idle-reaper scan behaviour (#229).
//
// The reaper asks CloudWatch for a browser pod's ALB RequestCount over the
// last `idleMinutes`. A pod younger than that window has had no chance to
// receive requests yet, so it must not be marked idle or stopped, however
// the metric reads. Before #229 a never-opened pod was stopped ~8 minutes
// after pod-up regardless of idleMinutes.
//
// The AWS SDK clients are mocked: each command is a plain object tagged with
// its class name, and one shared `send` mock dispatches on that name.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());

function mockClient(mod: string, commands: string[]) {
  vi.doMock(mod, () => {
    const exports: Record<string, unknown> = {};
    for (const name of commands) {
      exports[name] = class {
        readonly kind = name;
        constructor(readonly input: unknown) {}
      };
    }
    for (const client of ['CloudWatchClient', 'DynamoDBClient', 'LambdaClient', 'SNSClient']) {
      exports[client] = class {
        send = send;
      };
    }
    return exports;
  });
}

const NOW = new Date('2026-11-03T06:00:00Z');

interface Pod {
  podName: string;
  mode: 'browser' | 'tunnel';
  targetGroupArn?: string;
  createdAt?: string;
  idleMinutes?: number;
  idleSince?: string;
}

function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

// `datapoints`: what CloudWatch returns for RequestCount. `[{ Sum: 0 }]` is
// the "no requests in the window" reading that triggers the reaper.
function wire(pods: Pod[], datapoints: { Sum: number }[] = [{ Sum: 0 }]) {
  const calls: { kind: string; input: Record<string, unknown> }[] = [];
  send.mockImplementation(async (cmd: { kind: string; input: Record<string, unknown> }) => {
    calls.push(cmd);
    switch (cmd.kind) {
      case 'ScanCommand':
        return { Items: pods };
      case 'GetMetricStatisticsCommand':
        return { Datapoints: datapoints };
      default:
        return {};
    }
  });
  return calls;
}

async function loadHandler() {
  mockClient('@aws-sdk/client-cloudwatch', ['GetMetricStatisticsCommand']);
  mockClient('@aws-sdk/client-dynamodb', []);
  vi.doMock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send }) },
    ScanCommand: class { readonly kind = 'ScanCommand'; constructor(readonly input: unknown) {} },
    UpdateCommand: class { readonly kind = 'UpdateCommand'; constructor(readonly input: unknown) {} },
  }));
  mockClient('@aws-sdk/client-lambda', ['InvokeCommand']);
  mockClient('@aws-sdk/client-sns', ['PublishCommand']);
  return (await import('../lambda/idle-reaper/handler')).handler;
}

const TG = 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/hello/abc';

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.REGISTRY_TABLE_NAME = 'registry';
  process.env.POD_MANAGER_FN_NAME = 'pod-manager';
  process.env.IDLE_TOPIC_ARN = 'arn:aws:sns:us-west-2:123456789012:idle';
  process.env.ALB_NAME_DIMENSION = 'app/alb/123';
  process.env.IDLE_MINUTES_DEFAULT = '60';
});

afterEach(() => {
  vi.useRealTimers();
});

const scheduled = { source: 'aws.events', 'detail-type': 'Scheduled Event' };

describe('idle-reaper scan', () => {
  it('does not mark a pod younger than idleMinutes idle, even with zero requests', async () => {
    const calls = wire([
      { podName: 'hello', mode: 'browser', targetGroupArn: TG, createdAt: minutesAgo(3), idleMinutes: 60 },
    ]);
    const handler = await loadHandler();

    const r = await handler(scheduled);

    expect(r).toMatchObject({ ok: true, stopped: [], warned: [] });
    expect(calls.map((c) => c.kind)).not.toContain('UpdateCommand');
    expect(calls.map((c) => c.kind)).not.toContain('PublishCommand');
    expect(calls.map((c) => c.kind)).not.toContain('InvokeCommand');
  });

  it('does not stop a young pod that already carries idleSince', async () => {
    const calls = wire([
      {
        podName: 'hello', mode: 'browser', targetGroupArn: TG,
        createdAt: minutesAgo(8), idleMinutes: 60, idleSince: minutesAgo(5),
      },
    ]);
    const handler = await loadHandler();

    const r = await handler(scheduled);

    expect(r).toMatchObject({ ok: true, stopped: [] });
    expect(calls.map((c) => c.kind)).not.toContain('InvokeCommand');
  });

  it('uses the default idle window when the pod has no idleMinutes', async () => {
    const calls = wire([
      { podName: 'hello', mode: 'browser', targetGroupArn: TG, createdAt: minutesAgo(30) },
    ]);
    const handler = await loadHandler();

    const r = await handler(scheduled);

    expect(r).toMatchObject({ ok: true, stopped: [], warned: [] });
    expect(calls.map((c) => c.kind)).not.toContain('InvokeCommand');
  });

  it('marks a pod older than idleMinutes idle, then stops it on the next scan', async () => {
    const pod: Pod = {
      podName: 'hello', mode: 'browser', targetGroupArn: TG, createdAt: minutesAgo(70), idleMinutes: 60,
    };
    let calls = wire([pod]);
    let handler = await loadHandler();

    expect(await handler(scheduled)).toMatchObject({ ok: true, warned: ['hello'], stopped: [] });
    expect(calls.map((c) => c.kind)).toContain('PublishCommand');

    vi.resetModules();
    calls = wire([{ ...pod, idleSince: minutesAgo(5) }]);
    handler = await loadHandler();

    expect(await handler(scheduled)).toMatchObject({ ok: true, stopped: ['hello'] });
    const invoke = calls.find((c) => c.kind === 'InvokeCommand');
    expect(invoke).toBeDefined();
  });

  it('still checks a pod with no createdAt (registry rows from older versions)', async () => {
    wire([{ podName: 'legacy', mode: 'browser', targetGroupArn: TG, idleMinutes: 60 }]);
    const handler = await loadHandler();

    expect(await handler(scheduled)).toMatchObject({ ok: true, warned: ['legacy'] });
  });

  it('skips pods with idleMinutes 0', async () => {
    const calls = wire([
      { podName: 'hello', mode: 'browser', targetGroupArn: TG, createdAt: minutesAgo(500), idleMinutes: 0 },
    ]);
    const handler = await loadHandler();

    expect(await handler(scheduled)).toMatchObject({ ok: true, checked: 0, stopped: [] });
    expect(calls.map((c) => c.kind)).not.toContain('GetMetricStatisticsCommand');
  });

  it('never reaps tunnel pods', async () => {
    wire([{ podName: 't1', mode: 'tunnel', createdAt: minutesAgo(500), idleMinutes: 60 }]);
    const handler = await loadHandler();

    expect(await handler(scheduled)).toMatchObject({ ok: true, checked: 0 });
  });
});
