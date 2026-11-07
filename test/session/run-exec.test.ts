import { describe, expect, type Mock, test, vi } from 'vitest';
import { PluginNotFoundError } from '../../src/errors.js';
import { PLUGIN_ENV_VAR, RECOMMENDED_MIN_VERSION } from '../../src/session/plugin.js';
import { type RunExecDeps, runExecSession } from '../../src/session/run-exec.js';
import type { AwsContext } from '../../src/types.js';

const ctx: AwsContext = {
  profile: 'prod',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};
const TASK_ID = '0123456789abcdef0123456789abcdef';
const input = { cluster: 'prod', task: TASK_ID, container: 'app', command: '/bin/sh', runtimeId: `${TASK_ID}-1234` };

function makeDeps(over: Partial<RunExecDeps> = {}) {
  const send = vi.fn(async () => ({
    clusterArn: 'arn:x/prod',
    taskArn: `arn:x/${TASK_ID}`,
    containerName: 'app',
    session: { sessionId: 'ecs-1', streamUrl: 'wss://x', tokenValue: 'tok' },
  }));
  const deps: RunExecDeps = {
    ecs: { send },
    findPluginPath: vi.fn(() => '/usr/bin/session-manager-plugin'),
    getPluginVersion: vi.fn(async () => '1.2.896.0'),
    runPlugin: vi.fn(async () => 0),
    warn: vi.fn(),
    env: { PATH: '/bin' },
    ...over,
  };
  return { deps, send };
}

describe('runExecSession', () => {
  test('throws PluginNotFoundError before calling ExecuteCommand when the plugin is missing', async () => {
    const { deps, send } = makeDeps({ findPluginPath: () => null });
    await expect(runExecSession(ctx, input, deps)).rejects.toBeInstanceOf(PluginNotFoundError);
    expect(send).not.toHaveBeenCalled();
  });

  test('starts the exec session and hands the plugin the ECS target and endpoint, with no TerminateSession', async () => {
    const { deps, send } = makeDeps();
    expect(await runExecSession(ctx, input, deps)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    const [pluginPath, invocation] = (deps.runPlugin as Mock).mock.calls[0] as [
      string,
      { args: string[]; env: NodeJS.ProcessEnv },
    ];
    expect(pluginPath).toBe('/usr/bin/session-manager-plugin');
    expect(invocation.args).toEqual([
      PLUGIN_ENV_VAR,
      'ap-northeast-2',
      'StartSession',
      'prod',
      JSON.stringify({ Target: `ecs:prod_${TASK_ID}_${TASK_ID}-1234` }),
      'https://ecs.ap-northeast-2.amazonaws.com',
    ]);
    expect(JSON.parse(invocation.env[PLUGIN_ENV_VAR] as string)).toEqual({
      SessionId: 'ecs-1',
      StreamUrl: 'wss://x',
      TokenValue: 'tok',
    });
  });

  test('warns when the plugin is older than the recommended version', async () => {
    const { deps } = makeDeps({ getPluginVersion: async () => '1.2.100.0' });
    await runExecSession(ctx, input, deps);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining(RECOMMENDED_MIN_VERSION));
  });

  test('returns the plugin exit code', async () => {
    const { deps } = makeDeps({ runPlugin: async () => 130 });
    expect(await runExecSession(ctx, input, deps)).toBe(130);
  });
});
