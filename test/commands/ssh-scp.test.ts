import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runProxy } from '../../src/commands/proxy.js';
import { runScp } from '../../src/commands/scp.js';
import { runSsh, type SshDeps } from '../../src/commands/ssh.js';
import { CliError } from '../../src/errors.js';
import { emptyHistory } from '../../src/storage/history.js';
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
const proxy = '"/node" "/cli.mjs" proxy --profile default --region ap-northeast-2 --target i-1 --port 22';

function fakeSpawn(outcome: { code?: number; errorCode?: string }) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    setImmediate(() => {
      if (outcome.errorCode) child.emit('error', Object.assign(new Error('spawn failed'), { code: outcome.errorCode }));
      else child.emit('exit', outcome.code ?? 0, null);
    });
    return child;
  });
}

function makeDeps(over: Partial<SshDeps> = {}): SshDeps {
  return {
    resolveContext: vi.fn(async () => ctx),
    listInstances: vi.fn(async () => ({ rows: [web, db], ssmUnavailable: false })),
    pickInstance: vi.fn(async (rows: InstanceRow[]) => rows[0] as InstanceRow),
    loadHistory: vi.fn(async () => emptyHistory()),
    configDir: '/tmp/ssm-commander-test',
    spawn: fakeSpawn({ code: 0 }) as unknown as SshDeps['spawn'],
    selfCommand: () => ['/node', '/cli.mjs'],
    info: vi.fn(),
    spinner: () => ({ stop() {}, fail() {} }),
    ...over,
  };
}

describe('runSsh', () => {
  test('spawns ssh with the built args and inherited stdio', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ code: 3 }) as unknown as SshDeps['spawn'] });
    const code = await runSsh(
      ['web', '-o', 'StrictHostKeyChecking=accept-new', 'hostname'],
      { profile: 'default', user: 'ubuntu' },
      deps,
    );
    expect(code).toBe(3);
    expect(deps.spawn).toHaveBeenCalledWith(
      'ssh',
      ['-o', `ProxyCommand=${proxy}`, '-l', 'ubuntu', '-o', 'StrictHostKeyChecking=accept-new', 'i-1', 'hostname'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(deps.pickInstance).not.toHaveBeenCalled();
  });

  test('opens the picker when no target is given and propagates the TTY error', async () => {
    const deps = makeDeps({
      pickInstance: vi.fn(async () => {
        throw new CliError('This command needs an interactive terminal; pass --profile/--region/target explicitly');
      }),
    });
    await expect(runSsh([], {}, deps)).rejects.toThrow('needs an interactive terminal');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  test('refuses a non-connectable target', async () => {
    await expect(runSsh(['db'], {}, makeDeps())).rejects.toThrow('Instance i-2 (db) cannot be connected: stopped');
  });

  test('maps a missing ssh binary to a CliError', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ errorCode: 'ENOENT' }) as unknown as SshDeps['spawn'] });
    await expect(runSsh(['web'], {}, deps)).rejects.toThrow('ssh was not found on PATH');
  });
});

describe('runScp', () => {
  test('resolves the remote target and spawns scp', async () => {
    const deps = makeDeps();
    expect(await runScp(['-r', './dir', 'ubuntu@web:/tmp'], { profile: 'default' }, deps)).toBe(0);
    expect(deps.spawn).toHaveBeenCalledWith(
      'scp',
      ['-o', `ProxyCommand=${proxy}`, '-o', 'User=ubuntu', '-r', './dir', 'i-1:/tmp'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  test('rejects before touching AWS when there is no remote operand', async () => {
    const deps = makeDeps();
    await expect(runScp(['./a', './b'], {}, deps)).rejects.toThrow('scp needs exactly one remote operand');
    expect(deps.resolveContext).not.toHaveBeenCalled();
  });
});

describe('runProxy', () => {
  afterEach(() => vi.restoreAllMocks());

  test('starts an AWS-StartSSHSession with portNumber and never writes to stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runSession = vi.fn(async () => 0);
    const code = await runProxy(
      { profile: 'default', region: 'ap-northeast-2', target: 'i-1', port: 2222 },
      { resolveContext: vi.fn(async () => ctx), runSession },
    );
    expect(code).toBe(0);
    expect(runSession).toHaveBeenCalledWith(ctx, {
      Target: 'i-1',
      DocumentName: 'AWS-StartSSHSession',
      Parameters: { portNumber: ['2222'] },
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('requires profile, region and target', async () => {
    await expect(
      runProxy({ region: 'ap-northeast-2', target: 'i-1', port: 22 }, { resolveContext: vi.fn(), runSession: vi.fn() }),
    ).rejects.toThrow(CliError);
  });
});
