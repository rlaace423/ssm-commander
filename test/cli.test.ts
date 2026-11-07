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
    expect(doctor?.options.map((o) => o.long)).toEqual(['--profile', '--region', '--ecs']);
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
