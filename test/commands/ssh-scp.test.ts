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
const proxy = "'/node' '/cli.mjs' proxy --profile 'default' --region 'ap-northeast-2' --target 'i-1' --port '22'";

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
    warn: vi.fn(),
    spinner: () => ({ stop() {}, fail() {} }),
    requireTty: vi.fn(),
    assertPlugin: vi.fn(),
    ...over,
  };
}

describe('runSsh', () => {
  test('uses an instance id as given when the listing is denied', async () => {
    const deps = makeDeps({
      listInstances: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' });
      }),
    });
    expect(await runSsh(['i-9'], {}, deps)).toBe(0);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ec2:DescribeInstances'));
    expect(deps.spawn).toHaveBeenCalledWith('ssh', expect.arrayContaining(['i-9']), expect.anything());
  });

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

  test('requires a TTY before any AWS call when no target is given', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('This command needs an interactive terminal; pass --profile/--region/target explicitly');
      },
    });
    await expect(runSsh([], {}, deps)).rejects.toThrow('needs an interactive terminal');
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  test('refuses a non-connectable target', async () => {
    await expect(runSsh(['db'], {}, makeDeps())).rejects.toThrow('Instance i-2 (db) cannot be connected: stopped');
  });

  test('accepts user@target, which wins over --user', async () => {
    const deps = makeDeps();
    await runSsh(['ubuntu@web', 'hostname'], { user: 'ignored' }, deps);
    expect(deps.spawn).toHaveBeenCalledWith(
      'ssh',
      ['-o', `ProxyCommand=${proxy}`, '-l', 'ubuntu', 'i-1', 'hostname'],
      expect.anything(),
    );
  });

  test('passes remote command flags such as --user through untouched', async () => {
    const deps = makeDeps();
    await runSsh(['web', 'mysql', '--user', 'root', '--port', '3306'], {}, deps);
    const args = (deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(args.slice(-5)).toEqual(['i-1', 'mysql', '--user', 'root', '--port', '3306'].slice(-5));
    expect(args).toContain('i-1');
  });

  test('rejects ssh options placed before the target with a clear message', async () => {
    const deps = makeDeps();
    await expect(runSsh(['-i', 'key.pem', 'web', 'hostname'], {}, deps)).rejects.toThrow(
      'The target must come first: ssm-commander ssh [--profile <profile>] [--region <region>] [--user <user>] <target> [ssh options] [command]',
    );
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
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

  test('maps StartSession errors to the same CliError guidance as connect', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    await expect(
      runProxy(
        { profile: 'default', region: 'ap-northeast-2', target: 'i-1', port: 22 },
        { resolveContext: vi.fn(async () => ctx), runSession: vi.fn(async () => Promise.reject(denied)) },
      ),
    ).rejects.toThrow('Profile "default" is not allowed to perform ssm:StartSession');
  });

  test('requires profile, region and target', async () => {
    await expect(
      runProxy({ region: 'ap-northeast-2', target: 'i-1', port: 22 }, { resolveContext: vi.fn(), runSession: vi.fn() }),
    ).rejects.toThrow(CliError);
  });
});

describe('login name by platform', () => {
  const ubuntu = row({ instanceId: 'i-5', name: 'ubu', platform: 'Ubuntu' });
  const ubuntuProxy = proxy.replace("--target 'i-1'", "--target 'i-5'");
  const platformDeps = (over: Partial<SshDeps> = {}) =>
    makeDeps({ listInstances: vi.fn(async () => ({ rows: [web, ubuntu], ssmUnavailable: false })), ...over });

  test('ssh logs in as ubuntu on an Ubuntu instance unless --user or user@ says otherwise', async () => {
    const deps = platformDeps();
    await runSsh(['ubu', 'hostname'], {}, deps);
    expect(deps.spawn).toHaveBeenCalledWith(
      'ssh',
      ['-o', `ProxyCommand=${ubuntuProxy}`, '-l', 'ubuntu', 'i-5', 'hostname'],
      expect.anything(),
    );
    const explicit = platformDeps();
    await runSsh(['ubu'], { user: 'admin' }, explicit);
    expect((explicit.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain('admin');
  });

  test('an instance of unknown platform keeps ec2-user', async () => {
    const deps = platformDeps();
    await runSsh(['web'], {}, deps);
    expect((deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain('ec2-user');
  });

  test('scp uses the same default login name', async () => {
    const deps = platformDeps();
    await runScp(['./a', 'ubu:/tmp/a'], {}, deps);
    expect((deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain('User=ubuntu');
  });

  test('when ssh fails with 255 and the login name was a default, a hint names --user', async () => {
    const deps = platformDeps({ spawn: fakeSpawn({ code: 255 }) as unknown as SshDeps['spawn'] });
    expect(await runSsh(['ubu'], {}, deps)).toBe(255);
    const messages = (deps.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes('"ubuntu"') && m.includes('--user'))).toBe(true);

    const explicit = platformDeps({ spawn: fakeSpawn({ code: 255 }) as unknown as SshDeps['spawn'] });
    await runSsh(['ubu'], { user: 'admin' }, explicit);
    const quiet = (explicit.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m));
    expect(quiet.some((m) => m.includes('--user'))).toBe(false);

    const ok = platformDeps();
    await runSsh(['ubu'], {}, ok);
    expect(
      (ok.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m)).some((m) => m.includes('--user')),
    ).toBe(false);
  });
});

describe('ssh short flags that belong to ssh', () => {
  test('-p or -r before the target explains that ssm-commander wants --profile/--region there', async () => {
    const deps = makeDeps();
    const err = await runSsh(['-p', 'default', 'web', 'hostname'], {}, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('--profile');
    expect((err as CliError).hint).toContain('ssm-commander ssh');
    const region = await runSsh(['-r', 'us-east-1', 'web'], {}, deps).catch((e: unknown) => e);
    expect((region as CliError).message).toContain('--region');
    expect(deps.resolveContext).not.toHaveBeenCalled();
  });

  test('-p with a profile name after the target is caught before ssh complains about the port', async () => {
    const deps = makeDeps();
    await expect(runSsh(['web', '-p', 'default', 'hostname'], {}, deps)).rejects.toThrow('--profile default');
    expect(deps.resolveContext).not.toHaveBeenCalled();
    await runSsh(['web', '-p', '2222', 'hostname'], {}, deps); // a real port is passed through
    expect((deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain('2222');
  });
});

describe('plugin check', () => {
  test('ssh and scp fail before any AWS call when the plugin is missing', async () => {
    const missing = () => {
      throw new CliError('session-manager-plugin was not found on PATH');
    };
    const ssh = makeDeps({ assertPlugin: missing });
    await expect(runSsh(['web', 'hostname'], {}, ssh)).rejects.toThrow('session-manager-plugin was not found');
    expect(ssh.resolveContext).not.toHaveBeenCalled();
    const scp = makeDeps({ assertPlugin: missing });
    await expect(runScp(['./a', 'web:/tmp/a'], {}, scp)).rejects.toThrow('session-manager-plugin was not found');
    expect(scp.spawn).not.toHaveBeenCalled();
  });
});
