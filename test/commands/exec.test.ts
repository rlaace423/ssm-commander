import { describe, expect, test, vi } from 'vitest';
import type { ClusterRow, ContainerInfo, ServiceSummary, TaskRow } from '../../src/aws/ecs.js';
import { type ExecDeps, runExec } from '../../src/commands/exec.js';
import { AccessDeniedError, CliError } from '../../src/errors.js';
import { emptyHistory, recordExec } from '../../src/storage/history.js';
import type { AwsContext } from '../../src/types.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const ctx: AwsContext = {
  profile: 'prod',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};

const cluster = (name: string, over: Partial<ClusterRow> = {}): ClusterRow => ({
  name,
  arn: `arn:x/${name}`,
  status: 'ACTIVE',
  services: 1,
  runningTasks: 1,
  connectable: true,
  reason: null,
  ...over,
});
const service = (name: string, over: Partial<ServiceSummary> = {}): ServiceSummary => ({
  name,
  arn: `arn:x/${name}`,
  desired: 1,
  running: 1,
  launchType: 'FARGATE',
  taskDefinition: `${name}:1`,
  execEnabled: true,
  status: 'ACTIVE',
  ...over,
});
const container = (name: string, over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  name,
  runtimeId: `${name}-rt`,
  lastStatus: 'RUNNING',
  agentStatus: 'RUNNING',
  ...over,
});
const task = (taskId: string, over: Partial<TaskRow> = {}): TaskRow => ({
  taskId,
  arn: `arn:x/${taskId}`,
  cluster: 'prod',
  service: 'api',
  lastStatus: 'RUNNING',
  health: null,
  launchType: 'FARGATE',
  startedAt: null,
  availabilityZone: null,
  execEnabled: true,
  taskDefinition: 'api:1',
  containers: [container('app')],
  agentStatus: 'RUNNING',
  connectable: true,
  reason: null,
  ...over,
});

interface World {
  clusters: ClusterRow[];
  services: Record<string, ServiceSummary[]>;
  tasks: Record<string, TaskRow[]>;
}

function makeDeps(world: World, over: Partial<ExecDeps> = {}) {
  const ecs = { send: vi.fn() };
  const deps: ExecDeps = {
    resolveContext: vi.fn(async () => ctx),
    ecsClient: vi.fn(async () => ecs),
    fetchClusters: vi.fn(async () => world.clusters),
    fetchServices: vi.fn(async (_ecs, c: string) => world.services[c] ?? []),
    fetchTasks: vi.fn(async (_ecs, c: string, s?: string) =>
      (world.tasks[c] ?? []).filter((t) => s === undefined || t.service === s),
    ),
    describeTask: vi.fn(
      async (_ecs, c: string, id: string) => (world.tasks[c] ?? []).find((t) => t.taskId === id) ?? null,
    ),
    pickCluster: vi.fn(async (rows: ClusterRow[]) => rows[0] as ClusterRow),
    pickService: vi.fn(async (rows) => rows[0] as (typeof rows)[0]),
    pickTask: vi.fn(async (rows: TaskRow[]) => rows[0] as TaskRow),
    pickContainer: vi.fn(async (t: TaskRow) => t.containers[0] as ContainerInfo),
    runExecSession: vi.fn(async () => 0),
    requireTty: vi.fn(),
    assertPlugin: vi.fn(),
    info: vi.fn(),
    spinner: vi.fn(() => ({ stop: vi.fn(), fail: vi.fn() })),
    loadHistory: vi.fn(async () => emptyHistory()),
    saveHistory: vi.fn(async () => {}),
    configDir: '/tmp/ssm-commander-test',
    now: () => new Date('2026-11-08T00:00:00Z'),
    ...over,
  };
  return { deps, ecs };
}

const twoOfEverything: World = {
  clusters: [cluster('prod'), cluster('staging')],
  services: { prod: [service('api'), service('worker')] },
  tasks: {
    prod: [
      task(A, { containers: [container('app'), container('sidecar')] }),
      task(B),
      task('c'.repeat(32), { service: 'worker' }),
    ],
  },
};

describe('runExec interactive path', () => {
  test('asks for cluster, service, task and container when each has several choices', async () => {
    const { deps } = makeDeps(twoOfEverything);
    expect(await runExec(undefined, {}, deps)).toBe(0);
    expect(deps.pickCluster).toHaveBeenCalledWith(twoOfEverything.clusters, { recent: [] });
    expect(deps.pickService).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'api' }), expect.objectContaining({ name: 'worker' })]),
      'prod',
      { recent: [] },
    );
    expect(deps.pickTask).toHaveBeenCalledWith(
      [expect.objectContaining({ taskId: A }), expect.objectContaining({ taskId: B })],
      'api',
    );
    expect(deps.pickContainer).toHaveBeenCalledTimes(1);
    expect(deps.runExecSession).toHaveBeenCalledWith(ctx, {
      cluster: 'prod',
      task: A,
      container: 'app',
      command: '/bin/sh',
      runtimeId: 'app-rt',
    });
  });

  test('requires a terminal before resolving the context: the session is interactive', async () => {
    const { deps } = makeDeps(twoOfEverything, {
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await expect(runExec(undefined, {}, deps)).rejects.toThrow('no tty');
    expect(deps.resolveContext).not.toHaveBeenCalled();
  });

  test('skips every step that has a single choice and says what it used', async () => {
    const world: World = {
      clusters: [cluster('prod')],
      services: { prod: [service('api')] },
      tasks: { prod: [task(A)] },
    };
    const { deps } = makeDeps(world);
    await runExec(undefined, {}, deps);
    expect(deps.pickCluster).not.toHaveBeenCalled();
    expect(deps.pickService).not.toHaveBeenCalled();
    expect(deps.pickTask).not.toHaveBeenCalled();
    expect(deps.pickContainer).not.toHaveBeenCalled();
    const messages = (deps.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes('cluster "prod"'))).toBe(true);
    expect(messages.some((m) => m.includes('service "api"'))).toBe(true);
    expect(deps.runExecSession).toHaveBeenCalledWith(ctx, expect.objectContaining({ task: A, container: 'app' }));
  });

  test('--connectable hides unreachable rows from the pickers', async () => {
    const world: World = {
      clusters: [
        cluster('prod'),
        cluster('staging'),
        cluster('empty', { runningTasks: 0, connectable: false, reason: 'no running tasks' }),
      ],
      services: { prod: [service('api')] },
      tasks: { prod: [task(A), task(B, { connectable: false, reason: 'agent pending', agentStatus: 'PENDING' })] },
    };
    const { deps } = makeDeps(world);
    await runExec(undefined, { connectable: true }, deps);
    expect(deps.pickCluster).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'prod' }), expect.objectContaining({ name: 'staging' })],
      { recent: [] },
    );
    expect(deps.pickTask).not.toHaveBeenCalled(); // only one task left after filtering
    expect(deps.runExecSession).toHaveBeenCalledWith(ctx, expect.objectContaining({ task: A }));
  });

  test('passes --command through and uses --container without asking', async () => {
    const { deps } = makeDeps(twoOfEverything);
    await runExec('prod/api', { container: 'sidecar', command: 'bash' }, deps);
    expect(deps.pickContainer).not.toHaveBeenCalled();
    expect(deps.runExecSession).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ container: 'sidecar', command: 'bash', runtimeId: 'sidecar-rt' }),
    );
  });
});

describe('runExec and the connection history', () => {
  const D = 'd'.repeat(32);
  const E = 'e'.repeat(32);
  const recentWorld: World = {
    clusters: [cluster('prod'), cluster('staging')],
    services: { prod: [service('api'), service('worker')], staging: [service('api'), service('worker')] },
    tasks: {
      prod: [task(A), task(B, { service: 'worker' })],
      staging: [task(D, { cluster: 'staging' }), task(E, { cluster: 'staging', service: 'worker' })],
    },
  };
  const used = { profile: 'prod', region: 'ap-northeast-2', cluster: 'staging', service: 'worker' };
  const history = recordExec(
    recordExec(emptyHistory(), { ...used, profile: 'other', cluster: 'prod' }, new Date('2026-11-02T00:00:00Z')),
    used,
    new Date('2026-11-01T00:00:00Z'),
  );

  test('lists the recently used cluster and service of this profile first and tells the pickers which they are', async () => {
    const { deps } = makeDeps(recentWorld, { loadHistory: vi.fn(async () => history) });
    await runExec(undefined, {}, deps);
    expect(deps.pickCluster).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'staging' }), expect.objectContaining({ name: 'prod' })],
      { recent: ['staging'] },
    );
    expect(deps.pickService).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'worker' }), expect.objectContaining({ name: 'api' })],
      'staging',
      { recent: ['worker'] },
    );
  });

  test('a target written with the ecs: prefix, as forward --target has it, is the same target', async () => {
    const plain = makeDeps(twoOfEverything);
    await runExec('prod/api', {}, plain.deps);
    const prefixed = makeDeps(twoOfEverything);
    await runExec('ecs:prod/api', {}, prefixed.deps);
    expect(vi.mocked(prefixed.deps.runExecSession).mock.calls).toEqual(vi.mocked(plain.deps.runExecSession).mock.calls);
    expect(vi.mocked(prefixed.deps.runExecSession).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ cluster: 'prod' }),
    );
  });

  test('records the cluster and service after the session ends, as connect records the instance', async () => {
    const { deps } = makeDeps(twoOfEverything);
    await runExec('prod/api', {}, deps);
    expect(deps.saveHistory).toHaveBeenCalledWith('/tmp/ssm-commander-test', {
      version: 1,
      entries: [
        {
          kind: 'ecs',
          profile: 'prod',
          region: 'ap-northeast-2',
          cluster: 'prod',
          service: 'api',
          lastConnectedAt: '2026-11-08T00:00:00.000Z',
          count: 1,
        },
      ],
    });
  });

  test('a task outside a service is recorded with service null; a session that fails to start is not recorded', async () => {
    const standalone: World = {
      clusters: [cluster('prod')],
      services: {},
      tasks: { prod: [task(A, { service: null })] },
    };
    const { deps } = makeDeps(standalone);
    await runExec(undefined, { cluster: 'prod', task: A }, deps);
    expect(deps.saveHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entries: [expect.objectContaining({ cluster: 'prod', service: null })] }),
    );

    const failing = makeDeps(twoOfEverything, {
      runExecSession: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(runExec('prod/api', {}, failing.deps)).rejects.toThrow('boom');
    expect(failing.deps.saveHistory).not.toHaveBeenCalled();
  });
});

describe('runExec with explicit targets', () => {
  test("cluster/service lists only that service's tasks and skips the cluster and service listings", async () => {
    const { deps, ecs } = makeDeps(twoOfEverything);
    await runExec('prod/api', {}, deps);
    expect(deps.fetchClusters).not.toHaveBeenCalled();
    expect(deps.fetchServices).not.toHaveBeenCalled();
    expect(deps.fetchTasks).toHaveBeenCalledWith(ecs, 'prod', 'api');
    expect(deps.pickTask).toHaveBeenCalled();
  });

  test('--cluster with --task only describes that task: the calls the AWS CLI itself makes', async () => {
    const { deps, ecs } = makeDeps(twoOfEverything);
    await runExec(undefined, { cluster: 'prod', task: B }, deps);
    expect(deps.fetchClusters).not.toHaveBeenCalled();
    expect(deps.fetchServices).not.toHaveBeenCalled();
    expect(deps.fetchTasks).not.toHaveBeenCalled();
    expect(deps.describeTask).toHaveBeenCalledWith(ecs, 'prod', B);
    expect(deps.runExecSession).toHaveBeenCalledWith(ctx, expect.objectContaining({ task: B, container: 'app' }));
  });

  test('a task id alone is looked up in every cluster', async () => {
    const world: World = {
      ...twoOfEverything,
      tasks: { ...twoOfEverything.tasks, staging: [task('d'.repeat(32), { cluster: 'staging' })] },
    };
    const { deps } = makeDeps(world);
    await runExec('d'.repeat(32), {}, deps);
    expect(deps.describeTask).toHaveBeenCalledTimes(2);
    expect(deps.runExecSession).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ cluster: 'staging', task: 'd'.repeat(32) }),
    );
  });

  test('an explicit task that cannot be reached fails with the reason', async () => {
    const world: World = {
      ...twoOfEverything,
      tasks: { prod: [task(A, { connectable: false, reason: 'exec disabled' })] },
    };
    const { deps } = makeDeps(world);
    await expect(runExec(undefined, { cluster: 'prod', task: A }, deps)).rejects.toThrow(
      /cannot be reached: exec disabled/,
    );
    expect(deps.runExecSession).not.toHaveBeenCalled();
  });

  test('an unknown task, service or container is reported', async () => {
    const { deps } = makeDeps(twoOfEverything);
    await expect(runExec(undefined, { cluster: 'prod', task: 'f'.repeat(32) }, deps)).rejects.toThrow(
      /was not found in cluster "prod"/,
    );
    await expect(runExec('prod/nope', {}, deps)).rejects.toThrow(/No running tasks in service "nope"/);
    await expect(runExec('prod/api', { container: 'db' }, deps)).rejects.toThrow(/Container "db".*app, sidecar/);
  });

  test('a denied cluster listing says how to connect without it', async () => {
    const { deps } = makeDeps(twoOfEverything, {
      fetchClusters: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }),
    });
    const err = await runExec(undefined, {}, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect((err as CliError).hint).toContain('--cluster');
  });
});

describe('messages name the region and profile', () => {
  test('a region without clusters', async () => {
    const { deps } = makeDeps({ clusters: [], services: {}, tasks: {} });
    await expect(runExec(undefined, {}, deps)).rejects.toThrow(
      'No ECS clusters found in ap-northeast-2 (profile prod)',
    );
  });

  test('a cluster ECS does not know (ClusterNotFoundException) is named together with its region', async () => {
    const { deps } = makeDeps(twoOfEverything, {
      fetchTasks: vi.fn(async () => {
        throw Object.assign(new Error('Cluster not found.'), { name: 'ClusterNotFoundException' });
      }),
    });
    await expect(runExec('nothing/nothing', {}, deps)).rejects.toThrow(
      'Cluster "nothing" was not found in ap-northeast-2 (profile "prod")',
    );
  });

  test('the terminal check explains that the session itself is interactive', async () => {
    const { deps } = makeDeps(twoOfEverything);
    await runExec(undefined, {}, deps);
    expect(deps.requireTty).toHaveBeenCalledWith(expect.objectContaining({ what: expect.stringContaining('exec') }));
  });
});

describe('plugin check', () => {
  test('a missing plugin fails before any AWS call', async () => {
    const { deps } = makeDeps(twoOfEverything, {
      assertPlugin: () => {
        throw new CliError('session-manager-plugin was not found on PATH');
      },
    });
    await expect(runExec('prod/api', {}, deps)).rejects.toThrow('session-manager-plugin was not found');
    expect(deps.resolveContext).not.toHaveBeenCalled();
  });
});
