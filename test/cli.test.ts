import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProgram, main, type ProgramDeps } from '../src/cli.js';
import type { ConnectDeps } from '../src/commands/connect.js';

describe('createProgram', () => {
  test('hands injected deps to the command instead of the real wiring', async () => {
    const resolveContext = vi.fn().mockRejectedValue(new Error('stop here'));
    const connect = { resolveContext, requireTty: () => {}, assertPlugin: () => {} } as unknown as ConnectDeps;
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
    expect(program.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--debug', '--profile', '--region']));
  });

  test('every command accepts --debug after its name, hidden from help', async () => {
    const program = createProgram();
    for (const name of ['connect', 'exec', 'forward', 'ssh', 'scp', 'doctor']) {
      const debug = program.commands.find((c) => c.name() === name)?.options.find((o) => o.long === '--debug');
      expect(debug, name).toBeDefined();
      expect(debug?.hidden, name).toBe(true);
    }
    const resolveContext = vi.fn().mockRejectedValue(new Error('stop here'));
    const connect = { resolveContext, requireTty: () => {}, assertPlugin: () => {} } as unknown as ConnectDeps;
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

  test('forward takes --ecs with or without a target', () => {
    const forward = createProgram().commands.find((c) => c.name() === 'forward');
    const ecs = forward?.options.find((o) => o.long === '--ecs');
    expect(ecs?.optional).toBe(true);
    expect(ecs?.required).toBe(false);
  });

  test('the command list has one line per command; the ordering notes of ssh and scp stay in their own help', () => {
    const program = createProgram();
    expect(program.helpInformation()).not.toContain('Requires an SSH server');
    for (const name of ['ssh', 'scp']) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd?.summary(), name).toMatch(/through Session Manager$/);
      expect(cmd?.helpInformation(), name).toContain('Requires an SSH server');
    }
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
  const ctx = {
    profile: 'default',
    region: 'ap-northeast-2',
    credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
  };
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
      assertPlugin: vi.fn(),
    }) as unknown as ConnectDeps;

  afterEach(() => vi.restoreAllMocks());

  /** Runs a command line against the fakes: the exit code, what was printed on stderr, and the fakes to inspect. */
  const run = async (...args: string[]) => {
    const deps = makeDeps();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', ...args], { connect: deps });
    const stderr = err.mock.calls.map((c) => String(c[0])).join('');
    err.mockRestore();
    return { code, stderr, deps };
  };
  /** The command line was refused as written: nothing was checked, asked or fetched for it. */
  const expectNothingStarted = (deps: ConnectDeps) => {
    expect(deps.assertPlugin).not.toHaveBeenCalled();
    expect(deps.requireTty).not.toHaveBeenCalled();
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.listInstances).not.toHaveBeenCalled();
  };

  test('a mistyped command fails at once with the closest command: no plugin check, no prompt, no AWS call', async () => {
    const { code, stderr, deps } = await run('exsec');
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "exsec"');
    expect(stderr).toContain('Did you mean "ssm-commander exec"?');
    expectNothingStarted(deps);
  });

  test.each([
    { args: ['exsec', 'prod/api'], unknown: 'Unknown command "exsec"', meant: '"ssm-commander exec"' },
    { args: ['fowrard', '--list'], unknown: 'Unknown command "fowrard"', meant: '"ssm-commander forward"' },
    { args: ['shh', 'web', 'hostname'], unknown: 'Unknown command "shh"', meant: '"ssm-commander ssh"' },
  ])('a mistyped command is named even when followed by what connect does not take: $args', async (line) => {
    const { code, stderr, deps } = await run(...line.args);
    expect(code).toBe(1);
    expect(stderr).toContain(line.unknown);
    expect(stderr).toContain(line.meant);
    expectNothingStarted(deps);
  });

  test('a name without a command is not looked up among the instances: the hint shows where the command goes', async () => {
    const { code, stderr, deps } = await run('web'); // the fake listing has an instance of this very name
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "web"');
    expect(stderr).toContain('"ssm-commander connect web"');
    expect(stderr).toContain('"ssm-commander exec web"');
    expectNothingStarted(deps);
  });

  test('a name after options alone is refused the same way', async () => {
    const { code, stderr, deps } = await run('-p', 'default', 'web');
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "web"');
    expect(stderr).toContain('"ssm-commander connect web"');
    expectNothingStarted(deps);
  });

  test('a command after an option that only commands take is told to come first, with the line to write', async () => {
    const { code, stderr, deps } = await run('--connectable', 'exec');
    expect(code).toBe(1);
    expect(stderr).toContain('"exec" must come before "--connectable"');
    expect(stderr).toContain('Only -p, -r and --debug go before the command');
    expect(stderr).toContain('"ssm-commander exec --connectable"');
    expectNothingStarted(deps);
  });

  test.each([
    { args: ['--connectable', 'exec', 'prod/api'], line: '"ssm-commander exec --connectable prod/api"' },
    { args: ['--cluster', 'prod', 'exec'], line: '"ssm-commander exec --cluster prod"' },
    { args: ['--cluster=prod', 'exec'], line: '"ssm-commander exec --cluster=prod"' },
    {
      args: ['--connectable', 'forward', '--target', 'web'],
      line: '"ssm-commander forward --connectable --target web"',
    },
    { args: ['--connectable', 'connect', 'web'], line: '"ssm-commander connect --connectable web"' },
    // after ssh, -p would be ssh's own port option: what the program took stays in front of the command
    {
      args: ['-p', 'default', '--connectable', 'ssh', 'web'],
      line: '"ssm-commander -p default ssh --connectable web"',
    },
    {
      args: ['--region', 'eu-west-1', '--debug', '--profile', 'default', '--connectable', 'exec'],
      line: '"ssm-commander -p default -r eu-west-1 --debug exec --connectable"',
    },
    {
      args: ['--connectable', 'exec', '--command', 'ls -l'],
      line: `"ssm-commander exec --connectable --command 'ls -l'"`,
    },
  ])('the line to write keeps the rest of $args in its order, whatever follows the command', async (line) => {
    const { code, stderr, deps } = await run(...line.args);
    expect(code).toBe(1);
    expect(stderr).toContain('must come before');
    expect(stderr).toContain(line.line);
    expect(stderr).not.toContain('too many arguments');
    expect(stderr).not.toContain('unknown option');
    expectNothingStarted(deps);
  });

  test('the value of -p or -r is never taken for a command, even when a profile is named like one', async () => {
    const { code, deps } = await run('--connectable', '-p', 'exec');
    expect(code).toBe(0);
    expect(deps.resolveContext).toHaveBeenCalledWith({ profile: 'exec', region: undefined });
  });

  test.each([
    { args: ['--connectable', 'web'] },
    { args: ['--connectable', 'web', 'extra'] },
    { args: ['--connectable', '-pdefault', 'web'] },
    { args: ['--connectable', '--region=eu-west-1', 'web'] },
  ])('a name after an option of connect is still a word without a command: $args', async (line) => {
    const { code, stderr, deps } = await run(...line.args);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "web"');
    expect(stderr).not.toContain('too many arguments');
    expectNothingStarted(deps);
  });

  test('an option connect does not have is reported as such, and the word after it is not looked up', async () => {
    const { code, stderr, deps } = await run('--bogus', 'web');
    expect(code).toBe(1);
    expect(stderr).toContain("unknown option '--bogus'");
    expectNothingStarted(deps);
  });

  test('a mistyped command also shows how to write the word as a target', async () => {
    const { stderr } = await run('docker');
    expect(stderr).toContain('Did you mean "ssm-commander doctor"?');
    expect(stderr).toContain('"ssm-commander connect docker"');
  });

  test('an instance id is pointed to connect alone, a cluster/service to exec alone', async () => {
    const id = await run('i-0123456789abcdef0');
    expect(id.stderr).toContain('"ssm-commander connect i-0123456789abcdef0"');
    expect(id.stderr).not.toContain('ssm-commander exec');

    const service = await run('prod/api');
    expect(service.stderr).toContain('"ssm-commander exec prod/api"');
    expect(service.stderr).not.toContain('ssm-commander connect');
  });

  test('without a command word connect runs, with the options given', async () => {
    const bare = await run();
    expect(bare.code).toBe(0);
    expect(bare.deps.pickInstance).toHaveBeenCalled();
    expect(bare.deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-1' });

    const withOptions = await run('-p', 'default', '--connectable');
    expect(withOptions.code).toBe(0);
    expect(withOptions.deps.resolveContext).toHaveBeenCalledWith({ profile: 'default', region: undefined });
    expect(withOptions.deps.runSession).toHaveBeenCalledWith(ctx, { Target: 'i-1' });
  });

  test('with "connect" written out, any word is a target', async () => {
    const { code, deps } = await run('connect', 'conect', '-p', 'default');
    expect(code).toBe(0);
    expect(deps.info).toHaveBeenCalledWith(expect.stringContaining('No instance named "conect"'));
    expect(deps.pickInstance).toHaveBeenCalled();
  });
});

describe('-p and -r before the command', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Fakes for every command that stop where each one first uses its options: resolving the AWS context. */
  const fakes = () => {
    const stop = () => vi.fn().mockRejectedValue(new Error('stop here'));
    const base = () => ({ resolveContext: stop(), requireTty: () => {}, assertPlugin: () => {} });
    return {
      connect: base(),
      exec: base(),
      forward: {
        ...base(),
        loadPresets: async () => ({ version: 1, presets: [] }),
        configDir: '/tmp/ssm-commander-test',
      },
      ssh: base(),
      scp: base(),
      doctor: {
        resolveContext: stop(),
        nodeVersion: 'v24.0.0',
        findPluginPath: () => null,
        getPluginVersion: async () => null,
        loadSharedConfig: async () => ({ configFile: {}, credentialsFile: {} }),
        getCallerIdentity: vi.fn(),
        writeStdout: () => {},
        env: {},
      },
    };
  };
  type Fakes = ReturnType<typeof fakes>;

  const run = async (...args: string[]) => {
    const deps = fakes();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', ...args], deps as unknown as ProgramDeps);
    const stderr = err.mock.calls.map((c) => String(c[0])).join('');
    err.mockRestore();
    return { code, stderr, deps };
  };

  test.each<{ command: keyof Fakes; args: string[] }>([
    { command: 'connect', args: ['-p', 'prod', 'connect', 'web'] },
    { command: 'exec', args: ['-p', 'prod', 'exec', 'prod/api'] },
    { command: 'forward', args: ['-p', 'prod', 'forward', '--target', 'web'] },
    { command: 'ssh', args: ['-p', 'prod', 'ssh', 'web'] },
    { command: 'scp', args: ['-p', 'prod', 'scp', 'web:/tmp/a', './a'] },
    { command: 'doctor', args: ['-p', 'prod', 'doctor'] },
  ])('$command takes the profile written before it', async ({ command, args }) => {
    const { stderr, deps } = await run(...args);
    expect(stderr).not.toContain('too many arguments');
    expect(stderr).not.toContain('unknown option');
    expect(deps[command].resolveContext).toHaveBeenCalledWith(expect.objectContaining({ profile: 'prod' }));
  });

  test('the region goes the same way, in the long and the short form', async () => {
    const long = await run('--profile', 'prod', '--region', 'eu-west-1', 'exec');
    expect(long.deps.exec.resolveContext).toHaveBeenCalledWith({ profile: 'prod', region: 'eu-west-1' });

    const short = await run('-r', 'eu-west-1', 'connect', 'web');
    expect(short.deps.connect.resolveContext).toHaveBeenCalledWith({ profile: undefined, region: 'eu-west-1' });
  });

  test('what is written before the command and after it is combined, and the one after it wins', async () => {
    const combined = await run('-p', 'prod', 'connect', 'web', '-r', 'eu-west-1');
    expect(combined.deps.connect.resolveContext).toHaveBeenCalledWith({ profile: 'prod', region: 'eu-west-1' });

    const twice = await run('-p', 'before', 'connect', '-p', 'after', 'web');
    expect(twice.deps.connect.resolveContext).toHaveBeenCalledWith({ profile: 'after', region: undefined });
  });

  test('forward --ecs takes the service that follows it, not a preset of that name', async () => {
    const { stderr, deps } = await run('forward', '--ecs', 'prod/api');
    expect(stderr).not.toContain('Preset');
    expect(deps.forward.resolveContext).toHaveBeenCalled();
  });

  test("after ssh, -p is still ssh's own port option", async () => {
    const { stderr, deps } = await run('-p', 'prod', 'ssh', 'web', '-p', '2222');
    expect(stderr).toContain('stop here'); // reached the AWS context: the line was accepted as written
    expect(deps.ssh.resolveContext).toHaveBeenCalledWith(expect.objectContaining({ profile: 'prod' }));
  });
});
