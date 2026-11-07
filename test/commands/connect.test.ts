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
    ...over,
  };
}

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

  test('tells the user and opens the picker when the target is not found', async () => {
    const deps = makeDeps();
    await runConnect('zzz', {}, deps);
    expect(deps.info).toHaveBeenCalledWith('No instance named "zzz"; choose from the list');
    expect(deps.pickInstance).toHaveBeenCalledWith(rows, expect.anything());
  });

  test('warns when SSM information is unavailable', async () => {
    const deps = makeDeps({ listInstances: vi.fn(async () => ({ rows, ssmUnavailable: true })) });
    await runConnect('i-1', {}, deps);
    expect(deps.warn).toHaveBeenCalledWith(
      'Not allowed to call ssm:DescribeInstanceInformation; SSM status is unknown for all instances',
    );
  });

  test('maps listing errors to CliError with the EC2 action', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' });
    const deps = makeDeps({ listInstances: vi.fn(async () => Promise.reject(denied)) });
    await expect(runConnect('i-1', {}, deps)).rejects.toThrow(
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
