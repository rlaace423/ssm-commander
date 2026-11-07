import { describe, expect, test, vi } from 'vitest';
import {
  buildForwardSessionInput,
  FORWARD_DOCUMENT,
  type ForwardDeps,
  runForward,
  validatePort,
} from '../../src/commands/forward.js';
import { CliError } from '../../src/errors.js';
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

function makeDeps(over: Partial<ForwardDeps> = {}, presets: PresetsFile = emptyPresets()) {
  const deps: ForwardDeps = {
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
    writeStdout: vi.fn(),
    spinner: () => ({ stop() {}, fail() {} }),
    ...over,
  };
  return deps;
}

describe('helpers', () => {
  test('buildForwardSessionInput produces the exact document and parameter shape', () => {
    expect(buildForwardSessionInput('i-1', 'db.internal', 5432, 15432)).toEqual({
      Target: 'i-1',
      DocumentName: FORWARD_DOCUMENT,
      Parameters: { host: ['db.internal'], portNumber: ['5432'], localPortNumber: ['15432'] },
    });
    expect(FORWARD_DOCUMENT).toBe('AWS-StartPortForwardingSessionToRemoteHost');
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
    expect(deps.requireTty).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalledWith(ctx, buildForwardSessionInput('i-1', 'localhost', 22, 2222));
  });

  test('rejects invalid port options before starting anything', async () => {
    const deps = makeDeps();
    await expect(
      runForward(undefined, { target: 'web', remoteHost: 'localhost', remotePort: '99999', localPort: '2222' }, deps),
    ).rejects.toThrow('Enter a port number between 1 and 65535');
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

  test('refuses a non-connectable target', async () => {
    const deps = makeDeps();
    await expect(
      runForward(undefined, { target: 'db', remoteHost: 'localhost', remotePort: '22', localPort: '2222' }, deps),
    ).rejects.toThrow('Instance i-2 (db) cannot be connected: stopped');
  });
});
