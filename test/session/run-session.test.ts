import { describe, expect, test, vi } from 'vitest';
import { PluginNotFoundError } from '../../src/errors.js';
import { RECOMMENDED_MIN_VERSION } from '../../src/session/plugin.js';
import { type RunSessionDeps, runSession } from '../../src/session/run-session.js';
import type { AwsContext } from '../../src/types.js';

const ctx: AwsContext = {
  profile: 'default',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};

function makeDeps(over: Partial<RunSessionDeps> = {}) {
  const send = vi
    .fn()
    .mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'StartSessionCommand'
        ? { SessionId: 's-1', StreamUrl: 'wss://x', TokenValue: 'tok' }
        : {},
    );
  const deps: RunSessionDeps = {
    ssm: { send },
    findPluginPath: vi.fn(() => '/usr/bin/session-manager-plugin'),
    getPluginVersion: vi.fn(async () => '1.2.896.0'),
    runPlugin: vi.fn(async () => 0),
    warn: vi.fn(),
    env: { PATH: '/bin' },
    ...over,
  };
  return { deps, send };
}

describe('runSession', () => {
  test('throws PluginNotFoundError before calling StartSession when the plugin is missing', async () => {
    const { deps, send } = makeDeps({ findPluginPath: () => null });
    await expect(runSession(ctx, { Target: 'i-1' }, deps)).rejects.toBeInstanceOf(PluginNotFoundError);
    expect(send).not.toHaveBeenCalled();
  });

  test('starts the session, runs the plugin with the built invocation, terminates the session, returns the exit code', async () => {
    const { deps, send } = makeDeps({ runPlugin: vi.fn(async () => 7) });
    expect(await runSession(ctx, { Target: 'i-1' }, deps)).toBe(7);
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'StartSessionCommand',
      'TerminateSessionCommand',
    ]);
    expect(send.mock.calls[1]?.[0].input).toEqual({ SessionId: 's-1' });
    const [pluginPath, invocation] = (deps.runPlugin as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { args: string[]; env: NodeJS.ProcessEnv },
    ];
    expect(pluginPath).toBe('/usr/bin/session-manager-plugin');
    expect(invocation.args[0]).toBe('AWS_SSM_START_SESSION_RESPONSE');
    expect(invocation.args[1]).toBe('ap-northeast-2');
    expect(invocation.args[3]).toBe('default');
    expect(invocation.args[5]).toBe('https://ssm.ap-northeast-2.amazonaws.com');
    expect(invocation.env.AWS_SSM_START_SESSION_RESPONSE).toContain('s-1');
    expect(invocation.env.PATH).toBe('/bin');
  });

  test('terminates the session even when runPlugin rejects, then rethrows', async () => {
    const boom = new Error('plugin crashed');
    const { deps, send } = makeDeps({ runPlugin: vi.fn(async () => Promise.reject(boom)) });
    await expect(runSession(ctx, { Target: 'i-1' }, deps)).rejects.toBe(boom);
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'StartSessionCommand',
      'TerminateSessionCommand',
    ]);
  });

  test('warns when the plugin version is older than the recommended minimum and not otherwise', async () => {
    const old = makeDeps({ getPluginVersion: vi.fn(async () => '1.2.700.0') });
    await runSession(ctx, { Target: 'i-1' }, old.deps);
    expect(old.deps.warn).toHaveBeenCalledWith(
      `session-manager-plugin 1.2.700.0 is older than the recommended ${RECOMMENDED_MIN_VERSION}; consider updating`,
    );
    const fresh = makeDeps();
    await runSession(ctx, { Target: 'i-1' }, fresh.deps);
    expect(fresh.deps.warn).not.toHaveBeenCalled();
    const unknown = makeDeps({ getPluginVersion: vi.fn(async () => null) });
    await runSession(ctx, { Target: 'i-1' }, unknown.deps);
    expect(unknown.deps.warn).not.toHaveBeenCalled();
  });
});
