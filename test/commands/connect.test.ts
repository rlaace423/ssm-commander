import { describe, expect, test, vi } from 'vitest';
import { type ConnectDeps, runConnect } from '../../src/commands/connect.js';
import { CliError } from '../../src/errors.js';
import { emptyHistory, type HistoryFile, recordConnection } from '../../src/storage/history.js';
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
const webA = row({ instanceId: 'i-1', name: 'web-a' });
const db = row({ instanceId: 'i-2', name: 'db', state: 'stopped', connectable: false, reason: 'stopped' });
const web1 = row({ instanceId: 'i-3', name: 'web' });
const web2 = row({ instanceId: 'i-4', name: 'web' });
const rows = [webA, db, web1, web2];
const now = new Date('2026-11-07T00:00:00Z');

function makeDeps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    resolveContext: vi.fn(async () => ctx),
    listInstances: vi.fn(async () => ({ rows, ssmUnavailable: false })),
    pickInstance: vi.fn(async (candidates: InstanceRow[]) => candidates[0] as InstanceRow),
    runSession: vi.fn(async () => 0),
    loadHistory: vi.fn(async () => emptyHistory()),
    saveHistory: vi.fn(async () => {}),
    configDir: '/tmp/ssm-commander-test',
    now: () => now,
    warn: vi.fn(),
    info: vi.fn(),
    spinner: () => ({ stop() {}, fail() {} }),
    requireTty: vi.fn(),
    assertPlugin: vi.fn(),
    ...over,
  };
}

const denied = () => Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' });

describe('runConnect without permission to list instances', () => {
  test('connects to an instance id as given, after a warning naming the missing action', async () => {
    const deps = makeDeps({
      listInstances: vi.fn(async () => {
        throw denied();
      }),
    });
    expect(await runConnect('i-9', {}, deps)).toBe(0);
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-9' });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ec2:DescribeInstances'));
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('a Name target cannot be resolved: the error suggests the instance id', async () => {
    const deps = makeDeps({
      listInstances: vi.fn(async () => {
        throw denied();
      }),
    });
    const err = await runConnect('web', {}, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toContain('instance id');
    expect(deps.runSession).not.toHaveBeenCalled();
  });
});

describe('runConnect', () => {
  test('connects to the resolved target and records history', async () => {
    const deps = makeDeps({ runSession: vi.fn(async () => 5) });
    expect(await runConnect('i-1', { profile: 'default' }, deps)).toBe(5);
    expect(deps.resolveContext).toHaveBeenCalledWith({ profile: 'default', region: undefined });
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-1' });
    expect(deps.pickInstance).not.toHaveBeenCalled();
    const [dir, file] = (deps.saveHistory as ReturnType<typeof vi.fn>).mock.calls[0] as [string, HistoryFile];
    expect(dir).toBe('/tmp/ssm-commander-test');
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({
      profile: 'default',
      region: 'ap-northeast-2',
      instanceId: 'i-1',
      instanceName: 'web-a',
      count: 1,
    });
    expect(deps.info).toHaveBeenCalledWith('Connecting to web-a (i-1) in ap-northeast-2 with profile default...');
  });

  test('resolves a target by Name tag and passes recent ids to the listing', async () => {
    const history = recordConnection(
      emptyHistory(),
      { profile: 'default', region: 'ap-northeast-2', instanceId: 'i-3', instanceName: 'web' },
      now,
    );
    const deps = makeDeps({ loadHistory: vi.fn(async () => history) });
    await runConnect('web-a', {}, deps);
    expect(deps.listInstances).toHaveBeenCalledWith(ctx, { recentIds: ['i-3'], connectableOnly: false });
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-1' });
  });

  test('throws CliError with the reason for a non-connectable target', async () => {
    const deps = makeDeps();
    await expect(runConnect('db', {}, deps)).rejects.toThrow(CliError);
    await expect(runConnect('db', {}, deps)).rejects.toThrow('Instance i-2 (db) cannot be connected: stopped');
    expect(deps.runSession).not.toHaveBeenCalled();
    expect(deps.saveHistory).not.toHaveBeenCalled();
  });

  test('opens the picker on the matching rows for an ambiguous name', async () => {
    const deps = makeDeps({ pickInstance: vi.fn(async () => web2) });
    await runConnect('web', {}, deps);
    expect(deps.info).toHaveBeenCalledWith('Several instances are named "web"; choose one');
    expect(deps.pickInstance).toHaveBeenCalledWith([web1, web2], expect.objectContaining({ recentIds: [] }));
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-4' });
  });

  test('opens the picker on all rows when no target is given, and only connectable rows with --connectable', async () => {
    const all = makeDeps();
    await runConnect(undefined, {}, all);
    expect(all.pickInstance).toHaveBeenCalledWith(rows, expect.objectContaining({ recentIds: [] }));
    expect(all.requireTty).toHaveBeenCalledWith(
      expect.objectContaining({ what: 'Picking an instance', hint: expect.stringContaining('instance') }),
    );
    const only = makeDeps();
    await runConnect(undefined, { connectable: true }, only);
    expect(only.pickInstance).toHaveBeenCalledWith([webA, web1, web2], expect.anything());
    expect(only.listInstances).toHaveBeenCalledWith(ctx, { recentIds: [], connectableOnly: false });
  });

  test('explains when --connectable leaves nothing to pick instead of saying no instances exist', async () => {
    const deps = makeDeps({ listInstances: vi.fn(async () => ({ rows: [db], ssmUnavailable: false })) });
    await expect(runConnect(undefined, { connectable: true }, deps)).rejects.toThrow(
      'No connectable instances (1 listed); run without --connectable to see them',
    );
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('checks for a TTY before any AWS call when no target is given', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await expect(runConnect(undefined, {}, deps)).rejects.toThrow('no tty');
    expect(deps.resolveContext).not.toHaveBeenCalled();
    await runConnect('i-1', {}, deps); // an explicit target needs no terminal
  });

  test('tells the user where it looked and opens the picker when a name is not found', async () => {
    const deps = makeDeps();
    await runConnect('zzz', {}, deps);
    expect(deps.info).toHaveBeenCalledWith(
      'No instance named "zzz" in ap-northeast-2 (profile default); choose from the list',
    );
    expect(deps.pickInstance).toHaveBeenCalledWith(rows, expect.anything());
  });

  test('a name is matched ignoring case', async () => {
    const deps = makeDeps();
    await runConnect('WEB-A', {}, deps);
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-1' });
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('an instance id that is not in the region fails with the region and profile, without the picker', async () => {
    const deps = makeDeps();
    const err = await runConnect('i-0123456789abcdef0', {}, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(
      'Instance i-0123456789abcdef0 was not found in ap-northeast-2 (profile default)',
    );
    expect((err as CliError).hint).toContain('region');
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('without a terminal a missing name is a one-line error instead of an offer to pick', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await expect(runConnect('zzz', {}, deps)).rejects.toThrow(
      'No instance named "zzz" in ap-northeast-2 (profile default)',
    );
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('an empty region says so with the region and profile, for a name and for the picker alike', async () => {
    const deps = makeDeps({ listInstances: vi.fn(async () => ({ rows: [], ssmUnavailable: false })) });
    await expect(runConnect('zzz', {}, deps)).rejects.toThrow('No instances found in ap-northeast-2 (profile default)');
    await expect(runConnect(undefined, {}, deps)).rejects.toThrow(
      'No instances found in ap-northeast-2 (profile default)',
    );
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('warns when SSM information is unavailable', async () => {
    const deps = makeDeps({ listInstances: vi.fn(async () => ({ rows, ssmUnavailable: true })) });
    await runConnect('i-1', {}, deps);
    expect(deps.warn).toHaveBeenCalledWith(
      'Not allowed to call ssm:DescribeInstanceInformation; SSM status is unknown for all instances',
    );
  });

  test('maps listing errors to CliError with the EC2 action when the picker needs the listing', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' });
    const deps = makeDeps({ listInstances: vi.fn(async () => Promise.reject(denied)) });
    await expect(runConnect(undefined, {}, deps)).rejects.toThrow(
      'Profile "default" is not allowed to perform ec2:DescribeInstances',
    );
  });

  test('maps session errors to CliError with the StartSession action', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    const deps = makeDeps({ runSession: vi.fn(async () => Promise.reject(denied)) });
    await expect(runConnect('i-1', {}, deps)).rejects.toThrow(
      'Profile "default" is not allowed to perform ssm:StartSession',
    );
  });
});

describe('runConnect with a target that reads like a command', () => {
  // The command line decides what is a command (see cli.test.ts); by the time connect runs, a target is a target.
  test('an instance that happens to be named like a command is connected to', async () => {
    const deps = makeDeps({
      listInstances: vi.fn(async () => ({ rows: [row({ instanceId: 'i-7', name: 'exec' })], ssmUnavailable: false })),
    });
    await runConnect('exec', {}, deps);
    expect(deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-7' });
  });

  test('a missing instance that resembles a command is a missing instance: the list is offered', async () => {
    const deps = makeDeps();
    await runConnect('conect', {}, deps);
    expect(deps.info).toHaveBeenCalledWith(
      'No instance named "conect" in ap-northeast-2 (profile default); choose from the list',
    );
    expect(deps.pickInstance).toHaveBeenCalled();
  });
});

describe('plugin check', () => {
  test('a missing plugin fails before any AWS call', async () => {
    const deps = makeDeps({
      assertPlugin: () => {
        throw new CliError('session-manager-plugin was not found on PATH');
      },
    });
    await expect(runConnect('i-1', {}, deps)).rejects.toThrow('session-manager-plugin was not found');
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.listInstances).not.toHaveBeenCalled();
  });
});
