import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProgram, main } from '../src/cli.js';
import type { ConnectDeps } from '../src/commands/connect.js';

describe('createProgram', () => {
  test('hands injected deps to the command instead of the real wiring', async () => {
    const resolveContext = vi.fn().mockRejectedValue(new Error('stop here'));
    const connect = { resolveContext, requireTty: () => {} } as unknown as ConnectDeps;
    const program = createProgram({ connect });
    await expect(program.parseAsync(['node', 'cli', 'connect', 'web-1'])).rejects.toThrow('stop here');
    expect(resolveContext).toHaveBeenCalledWith({ profile: undefined, region: undefined });
  });

  test('uses package name and version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const program = createProgram();
    expect(program.name()).toBe('ssm-commander');
    expect(program.version()).toBe(pkg.version);
  });

  test('registers connect as the default command with its options', () => {
    const program = createProgram();
    const connect = program.commands.find((c) => c.name() === 'connect');
    expect(connect).toBeDefined();
    expect((program as unknown as { _defaultCommandName?: string })._defaultCommandName).toBe('connect');
    const flags = connect?.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--profile', '--region', '--connectable']));
    expect(program.options.map((o) => o.long)).toContain('--debug');
  });

  test('every command accepts --debug after its name, hidden from help', async () => {
    const program = createProgram();
    for (const name of ['connect', 'exec', 'forward', 'ssh', 'scp', 'doctor']) {
      const debug = program.commands.find((c) => c.name() === name)?.options.find((o) => o.long === '--debug');
      expect(debug, name).toBeDefined();
      expect(debug?.hidden, name).toBe(true);
    }
    const resolveContext = vi.fn().mockRejectedValue(new Error('stop here'));
    const connect = { resolveContext, requireTty: () => {} } as unknown as ConnectDeps;
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['node', 'cli', 'connect', '--debug', 'web-1'], { connect })).toBe(1);
    expect(resolveContext).toHaveBeenCalled();
    const output = err.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('unknown option');
    expect(output).toContain('stop here');
    expect(output).toContain('at '); // the stack trace, which only --debug prints
    err.mockRestore();
  });

  test('registers exec with the ECS options', () => {
    const exec = createProgram().commands.find((c) => c.name() === 'exec');
    expect(exec).toBeDefined();
    expect(exec?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--profile',
        '--region',
        '--cluster',
        '--service',
        '--task',
        '--container',
        '--command',
        '--connectable',
      ]),
    );
  });

  test('registers ssh and scp with pass-through and a hidden proxy command', () => {
    const program = createProgram();
    for (const name of ['ssh', 'scp']) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd).toBeDefined();
      expect(cmd?.options.map((o) => o.long)).toEqual(
        expect.arrayContaining(['--profile', '--region', '--user', '--identity', '--port', '--connectable']),
      );
      expect(cmd?.options.map((o) => o.short).filter(Boolean)).toEqual([]);
      expect((cmd as unknown as { _passThroughOptions: boolean })._passThroughOptions).toBe(true);
      expect((cmd as unknown as { _allowUnknownOption: boolean })._allowUnknownOption).toBe(true);
    }
    const proxy = program.commands.find((c) => c.name() === 'proxy');
    expect((proxy as unknown as { _hidden: boolean })._hidden).toBe(true);
    expect(proxy?.options.filter((o) => o.required).map((o) => o.long)).toEqual(
      expect.arrayContaining(['--profile', '--region', '--target', '--port']),
    );
  });

  test('registers doctor with a profile option', () => {
    const doctor = createProgram().commands.find((c) => c.name() === 'doctor');
    expect(doctor?.options.filter((o) => !o.hidden).map((o) => o.long)).toEqual(['--profile', '--region', '--ecs']);
  });

  test('registers --ecs and --region on doctor', () => {
    const doctor = createProgram().commands.find((c) => c.name() === 'doctor');
    expect(doctor?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--profile', '--region', '--ecs']));
  });

  test('registers the ECS options of forward', () => {
    const forward = createProgram().commands.find((c) => c.name() === 'forward');
    expect(forward?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--ecs', '--container']));
  });

  test('registers forward with preset management options', () => {
    const forward = createProgram().commands.find((c) => c.name() === 'forward');
    expect(forward?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--target',
        '--remote-host',
        '--remote-port',
        '--local-port',
        '--save',
        '--list',
        '--delete',
      ]),
    );
  });
});

describe('main', () => {
  afterEach(() => vi.restoreAllMocks());

  test('--version prints the version and exits 0', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['node', 'cli', '--version'])).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain(pkg.version);
  });

  test("an unknown option exits 1 with commander's message on stderr", async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['node', 'cli', '--nope'])).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain("unknown option '--nope'");
  });

  test('a CliError is printed with its hint and its exit code is returned', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ssmc-'));
    vi.stubEnv('SSM_COMMANDER_HOME', home);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['node', 'cli', 'forward', '--delete', 'nope'])).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('Preset "nope" was not found');
    vi.unstubAllEnvs();
  });
});

describe('connect as the default command', () => {
  const row = {
    instanceId: 'i-1',
    name: 'web',
    state: 'running',
    ssm: 'Online',
    instanceType: null,
    privateIp: null,
    publicIp: null,
    platform: null,
    connectable: true,
    reason: null,
  };
  const ctx = { profile: 'default', region: 'ap-northeast-2', credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }) };
  const makeDeps = () =>
    ({
      resolveContext: vi.fn(async () => ctx),
      listInstances: vi.fn(async () => ({ rows: [row], ssmUnavailable: false })),
      pickInstance: vi.fn(async () => row),
      runSession: vi.fn(async () => 0),
      loadHistory: vi.fn(async () => ({ version: 1, entries: [] })),
      saveHistory: vi.fn(async () => {}),
      configDir: '/tmp/ssm-commander-test',
      now: () => new Date(),
      warn: vi.fn(),
      info: vi.fn(),
      spinner: () => ({ stop() {}, fail() {} }),
      requireTty: vi.fn(),
    }) as unknown as ConnectDeps;

  test('a mistyped command word is reported as such, but only when connect was implied', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const implied = makeDeps();
    expect(await main(['node', 'cli', 'conect', '-p', 'default'], { connect: implied })).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('Unknown command "conect"');
    expect(implied.runSession).not.toHaveBeenCalled();

    const explicit = makeDeps();
    expect(await main(['node', 'cli', 'connect', 'conect', '-p', 'default'], { connect: explicit })).toBe(0);
    expect(explicit.pickInstance).toHaveBeenCalled();
    err.mockRestore();
  });
});
