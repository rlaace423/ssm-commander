import { describe, expect, test, vi } from 'vitest';
import type { ClusterRow, ContainerInfo, ServiceSummary, TaskRow } from '../../src/aws/ecs.js';
import type { EcsSelectionDeps } from '../../src/commands/exec.js';
import {
  buildForwardSessionInput,
  FORWARD_DOCUMENT,
  type ForwardDeps,
  LOCAL_FORWARD_DOCUMENT,
  renderPresetList,
  runForward,
  validatePort,
} from '../../src/commands/forward.js';
import { CliError } from '../../src/errors.js';
import { emptyHistory, recordConnection, recordExec } from '../../src/storage/history.js';
import { emptyPresets, type ForwardPreset, type PresetsFile, upsertPreset } from '../../src/storage/presets.js';
import type { AwsContext, InstanceRow } from '../../src/types.js';

const ctx: AwsContext = {
  profile: 'default',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};
const row = (over: Partial<InstanceRow>): InstanceRow => ({
  instanceId: 'i-x',
  name: 'x',
  state: 'running',
  ssm: 'Online',
  instanceType: null,
  privateIp: null,
  publicIp: null,
  platform: null,
  connectable: true,
  reason: null,
  ...over,
});
const web = row({ instanceId: 'i-1', name: 'web' });
const db = row({ instanceId: 'i-2', name: 'db', state: 'stopped', connectable: false, reason: 'stopped' });
const preset: ForwardPreset = {
  name: 'web-ssh',
  profile: 'default',
  region: 'ap-northeast-2',
  instanceId: 'i-1',
  instanceName: 'web',
  remoteHost: 'localhost',
  remotePort: 22,
  localPort: 2222,
};

const TASK_A = 'a'.repeat(32);
const TASK_B = 'b'.repeat(32);
const ecsContainer = (name: string, over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  name,
  runtimeId: `${name}-rt`,
  lastStatus: 'RUNNING',
  agentStatus: 'RUNNING',
  ...over,
});
const ecsTask = (taskId: string, over: Partial<TaskRow> = {}): TaskRow => ({
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
  containers: [ecsContainer('app')],
  agentStatus: 'RUNNING',
  connectable: true,
  reason: null,
  ...over,
});
const ecsCluster: ClusterRow = {
  name: 'prod',
  arn: 'arn:x/prod',
  status: 'ACTIVE',
  services: 1,
  runningTasks: 2,
  connectable: true,
  reason: null,
};
const ecsService: ServiceSummary = {
  name: 'api',
  arn: 'arn:x/api',
  desired: 2,
  running: 2,
  launchType: 'FARGATE',
  taskDefinition: 'api:1',
  execEnabled: true,
  status: 'ACTIVE',
};
const ecsTasks = [ecsTask(TASK_A, { containers: [ecsContainer('app'), ecsContainer('sidecar')] }), ecsTask(TASK_B)];
const ecsPreset: ForwardPreset = {
  name: 'db-via-api',
  kind: 'ecs',
  profile: 'default',
  region: 'ap-northeast-2',
  cluster: 'prod',
  service: 'api',
  container: null,
  remoteHost: 'db.internal',
  remotePort: 5432,
  localPort: 15432,
};

function fakeEcs(over: Partial<EcsSelectionDeps> = {}): EcsSelectionDeps {
  const sender = { send: vi.fn() };
  return {
    ecsClient: vi.fn(async () => sender),
    fetchClusters: vi.fn(async () => [ecsCluster]),
    fetchServices: vi.fn(async () => [ecsService]),
    fetchTasks: vi.fn(async (_ecs, _cluster: string, service?: string) =>
      ecsTasks.filter((t) => service === undefined || t.service === service),
    ),
    describeTask: vi.fn(async (_ecs, _cluster: string, id: string) => ecsTasks.find((t) => t.taskId === id) ?? null),
    pickCluster: vi.fn(async (rows: ClusterRow[]) => rows[0] as ClusterRow),
    pickService: vi.fn(async (rows) => rows[0] as (typeof rows)[0]),
    pickTask: vi.fn(async (rows: TaskRow[]) => rows[0] as TaskRow),
    pickContainer: vi.fn(async (t: TaskRow) => t.containers[0] as ContainerInfo),
    ...over,
  };
}

function makeDeps(over: Partial<ForwardDeps> = {}, presets: PresetsFile = emptyPresets()) {
  const deps: ForwardDeps = {
    ecs: fakeEcs(),
    resolveContext: vi.fn(async () => ctx),
    listInstances: vi.fn(async () => ({ rows: [web, db], ssmUnavailable: false })),
    pickInstance: vi.fn(async (rows: InstanceRow[]) => rows[0] as InstanceRow),
    runSession: vi.fn(async () => 0),
    loadPresets: vi.fn(async () => presets),
    savePresets: vi.fn(async () => {}),
    configDir: '/tmp/ssm-commander-test',
    descriptionInput: vi.fn(async () => '8080'),
    confirmOverwrite: vi.fn(async () => true),
    requireTty: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    writeStdout: vi.fn(),
    spinner: () => ({ stop() {}, fail() {} }),
    loadHistory: vi.fn(async () => emptyHistory()),
    checkLocalPort: vi.fn(async () => {}),
    assertPlugin: vi.fn(),
    ...over,
  };
  return deps;
}

describe('local port check', () => {
  const ports = { remoteHost: 'db.internal', remotePort: '5432', localPort: '15432' };

  test('checks the local port before starting the session and refuses to start when it is taken', async () => {
    const deps = makeDeps();
    await runForward(undefined, { target: 'web', ...ports }, deps);
    expect(deps.checkLocalPort).toHaveBeenCalledWith(15432);
    const check = (deps.checkLocalPort as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Infinity;
    const session = (deps.runSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? -1;
    expect(check).toBeLessThan(session);

    const busy = makeDeps({
      checkLocalPort: vi.fn(async () => {
        throw new CliError('Local port 15432 is already in use');
      }),
    });
    await expect(runForward(undefined, { target: 'web', ...ports }, busy)).rejects.toThrow('already in use');
    expect(busy.runSession).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  test('buildForwardSessionInput produces the exact document and parameter shape', () => {
    expect(buildForwardSessionInput('i-1', 'db.internal', 5432, 15432)).toEqual({
      Target: 'i-1',
      DocumentName: FORWARD_DOCUMENT,
      Parameters: { host: ['db.internal'], portNumber: ['5432'], localPortNumber: ['15432'] },
    });
    expect(FORWARD_DOCUMENT).toBe('AWS-StartPortForwardingSessionToRemoteHost');
  });

  test('buildForwardSessionInput uses the plain port-forwarding document for the instance or task itself', () => {
    // ECS tasks refuse AWS-StartPortForwardingSessionToRemoteHost for localhost; the plain document works everywhere.
    for (const self of ['localhost', '127.0.0.1', '::1']) {
      expect(buildForwardSessionInput('i-1', self, 22, 2222)).toEqual({
        Target: 'i-1',
        DocumentName: LOCAL_FORWARD_DOCUMENT,
        Parameters: { portNumber: ['22'], localPortNumber: ['2222'] },
      });
    }
    expect(LOCAL_FORWARD_DOCUMENT).toBe('AWS-StartPortForwardingSession');
  });

  test('validatePort accepts 1 and 65535 and rejects 0, 65536, "abc"', () => {
    expect(validatePort('1')).toBe(true);
    expect(validatePort('65535')).toBe(true);
    for (const bad of ['0', '65536', 'abc', '', '22.5']) {
      expect(validatePort(bad)).toBe('Enter a port number between 1 and 65535');
    }
  });
});

describe('runForward', () => {
  test('with a preset name uses its values and option overrides, without prompting', async () => {
    const deps = makeDeps({}, upsertPreset(emptyPresets(), preset));
    expect(await runForward('web-ssh', { localPort: '3333' }, deps)).toBe(0);
    expect(deps.resolveContext).toHaveBeenCalledWith({ profile: 'default', region: 'ap-northeast-2' });
    expect(deps.listInstances).not.toHaveBeenCalled();
    expect(deps.descriptionInput).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledWith(ctx, buildForwardSessionInput('i-1', 'localhost', 22, 3333));
    expect(deps.info).toHaveBeenCalledWith(
      'Forwarding localhost:3333 -> localhost:22 via web (i-1). Press Ctrl+C to stop.',
    );
  });

  test('errors for an unknown preset name', async () => {
    await expect(runForward('nope', {}, makeDeps())).rejects.toThrow('Preset "nope" was not found');
  });

  test('without a preset resolves the target, prompts for missing values and starts the session', async () => {
    const deps = makeDeps({
      descriptionInput: vi
        .fn()
        .mockResolvedValueOnce('db.internal')
        .mockResolvedValueOnce('5432')
        .mockResolvedValueOnce('15432'),
    });
    await runForward(undefined, { target: 'web' }, deps);
    expect(deps.requireTty).toHaveBeenCalled();
    expect(deps.descriptionInput).toHaveBeenCalledTimes(3);
    expect(deps.runSession).toHaveBeenCalledWith(ctx, buildForwardSessionInput('i-1', 'db.internal', 5432, 15432));
    expect(deps.savePresets).not.toHaveBeenCalled();
  });

  test('opens the picker when no target is given and skips prompts for values given as options', async () => {
    const deps = makeDeps();
    await runForward(undefined, { remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps);
    expect(deps.pickInstance).toHaveBeenCalledWith([web, db], expect.anything());
    expect(deps.descriptionInput).not.toHaveBeenCalled();
    expect(deps.requireTty).toHaveBeenCalledTimes(1); // once, for the picker, before any AWS call
    expect(deps.runSession).toHaveBeenCalledWith(ctx, buildForwardSessionInput('i-1', 'localhost', 22, 2222));
  });

  test('requires a TTY before any AWS call when neither preset nor target is given', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await expect(
      runForward(undefined, { remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps),
    ).rejects.toThrow('no tty');
    expect(deps.resolveContext).not.toHaveBeenCalled();
  });

  test('requires a TTY before asking whether to overwrite an existing preset', async () => {
    const deps = makeDeps(
      {
        requireTty: () => {
          throw new CliError('no tty');
        },
      },
      upsertPreset(emptyPresets(), preset),
    );
    await expect(
      runForward(
        undefined,
        { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '3333', save: 'web-ssh' },
        deps,
      ),
    ).rejects.toThrow('no tty');
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.runSession).not.toHaveBeenCalled();
  });

  test('orders the instance list by connection history like connect does', async () => {
    const history = recordConnection(
      emptyHistory(),
      { profile: 'default', region: 'ap-northeast-2', instanceId: 'i-2', instanceName: 'db' },
      new Date('2026-11-07T00:00:00Z'),
    );
    const deps = makeDeps({ loadHistory: vi.fn(async () => history) });
    await runForward(undefined, { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps);
    expect(deps.listInstances).toHaveBeenCalledWith(ctx, { recentIds: ['i-2'], connectableOnly: false });
  });

  test('rejects invalid port options before starting anything', async () => {
    const deps = makeDeps();
    await expect(
      runForward(undefined, { target: 'web', remoteHost: 'localhost', remotePort: '99999', localPort: '2222' }, deps),
    ).rejects.toThrow('--remote-port must be a port number between 1 and 65535 (got "99999")');
    expect(deps.runSession).not.toHaveBeenCalled();
  });

  test('--save persists the preset before starting the session, asking before overwriting', async () => {
    const fresh = makeDeps();
    await runForward(
      undefined,
      { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '2222', save: 'web-ssh' },
      fresh,
    );
    const [dir, file] = (fresh.savePresets as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PresetsFile];
    expect(dir).toBe('/tmp/ssm-commander-test');
    expect(file.presets).toEqual([preset]);
    expect(fresh.confirmOverwrite).not.toHaveBeenCalled();
    expect((fresh.savePresets as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (fresh.runSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] as number,
    );

    const existing = makeDeps({ confirmOverwrite: vi.fn(async () => false) }, upsertPreset(emptyPresets(), preset));
    await runForward(
      undefined,
      { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '3333', save: 'web-ssh' },
      existing,
    );
    expect(existing.confirmOverwrite).toHaveBeenCalledWith('web-ssh');
    expect(existing.savePresets).not.toHaveBeenCalled();
    expect(existing.runSession).toHaveBeenCalled();
  });

  test('--list prints presets to stdout and "No presets saved" when empty', async () => {
    const empty = makeDeps();
    expect(await runForward(undefined, { list: true }, empty)).toBe(0);
    expect(empty.writeStdout).toHaveBeenCalledWith('No presets saved\n');
    expect(empty.resolveContext).not.toHaveBeenCalled();

    const some = makeDeps({}, upsertPreset(emptyPresets(), preset));
    await runForward(undefined, { list: true }, some);
    const out = (some.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('web-ssh');
    expect(out).toContain('localhost:22 -> 2222');
  });

  test('--delete removes the preset and errors for an unknown name', async () => {
    const deps = makeDeps({}, upsertPreset(emptyPresets(), preset));
    expect(await runForward(undefined, { delete: 'web-ssh' }, deps)).toBe(0);
    const [, file] = (deps.savePresets as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PresetsFile];
    expect(file.presets).toEqual([]);
    expect(deps.info).toHaveBeenCalledWith('Deleted preset "web-ssh"');
    await expect(runForward(undefined, { delete: 'ghost' }, makeDeps())).rejects.toThrow(CliError);
  });

  test('forwards through an instance id as given when the listing is denied', async () => {
    const deps = makeDeps({
      listInstances: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' });
      }),
    });
    await runForward(undefined, { target: 'i-9', remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ec2:DescribeInstances'));
    expect(deps.runSession).toHaveBeenCalledWith(ctx, expect.objectContaining({ Target: 'i-9' }));
  });

  test('refuses a non-connectable target', async () => {
    const deps = makeDeps();
    await expect(
      runForward(undefined, { target: 'db', remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps),
    ).rejects.toThrow('Instance i-2 (db) cannot be connected: stopped');
  });
});

describe('runForward through an ECS task', () => {
  const ports = { remoteHost: 'db.internal', remotePort: '5432', localPort: '15432' };

  test("--target ecs:cluster/service lists that service's tasks, asks which one, and forwards through it", async () => {
    const deps = makeDeps();
    expect(await runForward(undefined, { target: 'ecs:prod/api', ...ports }, deps)).toBe(0);
    expect(deps.ecs.fetchClusters).not.toHaveBeenCalled();
    expect(deps.ecs.fetchServices).not.toHaveBeenCalled();
    expect(deps.ecs.fetchTasks).toHaveBeenCalledWith(expect.anything(), 'prod', 'api');
    expect(deps.ecs.pickTask).toHaveBeenCalled();
    expect(deps.ecs.pickContainer).toHaveBeenCalled(); // task A has two containers
    expect(deps.listInstances).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledWith(ctx, {
      Target: `ecs:prod_${TASK_A}_app-rt`,
      DocumentName: FORWARD_DOCUMENT,
      Parameters: { host: ['db.internal'], portNumber: ['5432'], localPortNumber: ['15432'] },
    });
    expect(deps.info).toHaveBeenCalledWith(expect.stringContaining(`ECS task ${TASK_A}`));
  });

  test('--container picks the container without asking', async () => {
    const deps = makeDeps();
    await runForward(undefined, { target: 'ecs:prod/api', container: 'sidecar', ...ports }, deps);
    expect(deps.ecs.pickContainer).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ Target: `ecs:prod_${TASK_A}_sidecar-rt` }),
    );
  });

  test('--save stores an ECS preset with the cluster, service and container', async () => {
    const deps = makeDeps();
    await runForward(undefined, { target: 'ecs:prod/api', container: 'sidecar', save: 'db-via-api', ...ports }, deps);
    expect(deps.savePresets).toHaveBeenCalledWith('/tmp/ssm-commander-test', {
      version: 1,
      presets: [{ ...ecsPreset, container: 'sidecar' }],
    });
  });

  test('an ECS preset runs without prompts and takes the newest reachable task of the service', async () => {
    const deps = makeDeps({}, upsertPreset(emptyPresets(), ecsPreset));
    await runForward('db-via-api', {}, deps);
    expect(deps.ecs.pickTask).not.toHaveBeenCalled();
    expect(deps.ecs.pickContainer).not.toHaveBeenCalled();
    expect(deps.descriptionInput).not.toHaveBeenCalled();
    expect(deps.info).toHaveBeenCalledWith(expect.stringContaining(TASK_A));
    expect(deps.runSession).toHaveBeenCalledWith(ctx, expect.objectContaining({ Target: `ecs:prod_${TASK_A}_app-rt` }));
  });

  test('--ecs without a target requires a terminal first, then walks cluster, service and task', async () => {
    const blocked = makeDeps({
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await expect(runForward(undefined, { ecs: true, ...ports }, blocked)).rejects.toThrow('no tty');
    expect(blocked.resolveContext).not.toHaveBeenCalled();

    const deps = makeDeps();
    await runForward(undefined, { ecs: true, ...ports }, deps);
    expect(deps.ecs.fetchClusters).toHaveBeenCalled();
    expect(deps.ecs.fetchServices).toHaveBeenCalledWith(expect.anything(), 'prod');
    expect(deps.ecs.pickTask).toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ Target: expect.stringMatching(/^ecs:prod_/) }),
    );
  });

  test('--ecs lists the clusters and services that exec used before first, marked for the picker', async () => {
    const history = recordExec(
      emptyHistory(),
      { profile: 'default', region: 'ap-northeast-2', cluster: 'staging', service: 'api' },
      new Date(),
    );
    const deps = makeDeps({
      loadHistory: vi.fn(async () => history),
      ecs: fakeEcs({ fetchClusters: vi.fn(async () => [ecsCluster, { ...ecsCluster, name: 'staging' }]) }),
    });
    await runForward(undefined, { ecs: true, ...ports }, deps);
    expect(deps.ecs.pickCluster).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'staging' }), expect.objectContaining({ name: 'prod' })],
      { recent: ['staging'] },
    );
  });

  test('renderPresetList shows ECS presets as ecs:cluster/service', () => {
    const out = renderPresetList(upsertPreset(upsertPreset(emptyPresets(), preset), ecsPreset));
    expect(out).toContain('web (i-1)');
    expect(out).toContain('ecs:prod/api');
    expect(out).toContain('db.internal:5432 -> 15432');
  });
});

describe('conflicting or malformed options', () => {
  const ports = { remoteHost: 'db.internal', remotePort: '5432', localPort: '15432' };

  test('--list with --delete is refused before anything is read or written', async () => {
    const deps = makeDeps();
    await expect(runForward(undefined, { list: true, delete: 'x' }, deps)).rejects.toThrow(
      '--list and --delete cannot be combined',
    );
    expect(deps.writeStdout).not.toHaveBeenCalled();
    expect(deps.savePresets).not.toHaveBeenCalled();
  });

  test('--ecs with --target is refused and the hint shows the ecs: form of --target', async () => {
    const deps = makeDeps();
    const err = await runForward(undefined, { ecs: true, target: 'web', ...ports }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe('--ecs and --target cannot be combined');
    expect((err as CliError).hint).toContain('--target ecs:cluster/service');
    expect(deps.listInstances).not.toHaveBeenCalled();
    expect(deps.ecs.fetchClusters).not.toHaveBeenCalled();
  });

  test('a port option that is not a port names the option and the value', async () => {
    const deps = makeDeps();
    await expect(runForward(undefined, { target: 'web', ...ports, localPort: 'abc' }, deps)).rejects.toThrow(
      '--local-port must be a port number between 1 and 65535 (got "abc")',
    );
    expect(deps.runSession).not.toHaveBeenCalled();
  });

  test('the terminal checks say what would be asked and which options avoid it', async () => {
    const deps = makeDeps();
    await runForward(undefined, { target: 'web' }, deps);
    expect(deps.requireTty).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining('--remote-host, --remote-port and --local-port') }),
    );
    const picker = makeDeps();
    await runForward(undefined, ports, picker);
    expect(picker.requireTty).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining('--target') }),
    );
  });
});

describe('plugin check', () => {
  const missing = () => {
    throw new CliError('session-manager-plugin was not found on PATH');
  };

  test('a missing plugin fails before any AWS call, but --list and --delete need no plugin', async () => {
    const deps = makeDeps({ assertPlugin: missing });
    await expect(
      runForward(undefined, { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps),
    ).rejects.toThrow('session-manager-plugin was not found');
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(await runForward(undefined, { list: true }, makeDeps({ assertPlugin: missing }))).toBe(0);
  });
});

describe('hint after an interactive forward', () => {
  const infos = (deps: ForwardDeps) => (deps.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m));
  const prompts = () =>
    vi.fn().mockResolvedValueOnce('db.internal').mockResolvedValueOnce('5432').mockResolvedValueOnce('15432');

  test('after picking and answering prompts, the equivalent command line is shown last', async () => {
    const deps = makeDeps({ descriptionInput: prompts() });
    await runForward(undefined, {}, deps);
    expect(infos(deps).at(-1)).toBe(
      'To repeat this without prompts: ssm-commander forward --target web --remote-host db.internal --remote-port 5432 --local-port 15432 -p default -r ap-northeast-2 (add --save <name> to keep it as a preset)',
    );
  });

  test('an ECS hop is written as --target ecs:cluster/service, with the container chosen among several', async () => {
    const deps = makeDeps({ descriptionInput: prompts() });
    await runForward(undefined, { ecs: true }, deps);
    expect(infos(deps).at(-1)).toContain('--target ecs:prod/api --container app --remote-host db.internal');
  });

  test('nothing is suggested for a preset, a complete command line, or a run that was saved', async () => {
    const fromPreset = makeDeps({}, upsertPreset(emptyPresets(), preset));
    await runForward('web-ssh', {}, fromPreset);
    const complete = makeDeps();
    await runForward(
      undefined,
      { target: 'web', remoteHost: 'localhost', remotePort: '22', localPort: '2222' },
      complete,
    );
    const saved = makeDeps({ descriptionInput: prompts() });
    await runForward(undefined, { save: 'new' }, saved);
    for (const deps of [fromPreset, complete, saved]) {
      expect(infos(deps).some((m) => m.startsWith('To repeat this'))).toBe(false);
    }
  });
});
