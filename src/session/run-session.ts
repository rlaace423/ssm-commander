import { existsSync } from 'node:fs';
import { createSsmClient } from '../aws/clients.js';
import { ssmEndpoint, startSession, terminateSession } from '../aws/session.js';
import { PluginNotFoundError } from '../errors.js';
import type { AwsContext, Sender, StartSessionInput } from '../types.js';
import { warn } from '../ui/output.js';
import {
  buildPluginInvocation,
  compareVersions,
  findPluginPath,
  getPluginVersion,
  type PluginInvocation,
  RECOMMENDED_MIN_VERSION,
  runPlugin,
} from './plugin.js';

export interface RunSessionDeps {
  ssm: Sender;
  findPluginPath: () => string | null;
  getPluginVersion: (pluginPath: string) => Promise<string | null>;
  runPlugin: (pluginPath: string, invocation: PluginInvocation) => Promise<number>;
  warn: (message: string) => void;
  env: NodeJS.ProcessEnv;
}

export function defaultRunSessionDeps(ctx: AwsContext): RunSessionDeps {
  return {
    ssm: createSsmClient(ctx),
    findPluginPath: () => findPluginPath({ env: process.env, platform: process.platform, exists: existsSync }),
    getPluginVersion,
    runPlugin: (pluginPath, invocation) => runPlugin(pluginPath, invocation),
    warn,
    env: process.env,
  };
}

/** Locates the plugin and reads its version (warning when it is old) before any session is started. */
export async function preparePlugin(
  deps: Pick<RunSessionDeps, 'findPluginPath' | 'getPluginVersion' | 'warn'>,
): Promise<{ pluginPath: string; pluginVersion: string | null }> {
  const pluginPath = deps.findPluginPath();
  if (pluginPath === null) throw new PluginNotFoundError();

  const pluginVersion = await deps.getPluginVersion(pluginPath);
  if (pluginVersion !== null && compareVersions(pluginVersion, RECOMMENDED_MIN_VERSION) < 0) {
    deps.warn(
      `session-manager-plugin ${pluginVersion} is older than the recommended ${RECOMMENDED_MIN_VERSION}; consider updating`,
    );
  }
  return { pluginPath, pluginVersion };
}

/** StartSession → plugin → TerminateSession. The plugin is located first so a missing plugin never leaves a session behind. */
export async function runSession(ctx: AwsContext, input: StartSessionInput, deps: RunSessionDeps): Promise<number> {
  const { pluginPath, pluginVersion } = await preparePlugin(deps);

  const session = await startSession(deps.ssm, input);
  try {
    const invocation = buildPluginInvocation({
      session,
      region: ctx.region,
      profile: ctx.profile,
      parameters: input,
      endpoint: ssmEndpoint(ctx.region),
      pluginVersion,
      baseEnv: deps.env,
    });
    return await deps.runPlugin(pluginPath, invocation);
  } finally {
    await terminateSession(deps.ssm, session.SessionId);
  }
}
