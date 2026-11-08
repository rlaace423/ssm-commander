import { execFile } from 'node:child_process';
import path from 'node:path';
import { CliError, PluginNotFoundError } from '../errors.js';
import type { SessionStart, StartSessionInput } from '../types.js';
import { type SpawnInheritedDeps, spawnInherited } from './spawn-inherited.js';

export const PLUGIN_ENV_VAR = 'AWS_SSM_START_SESSION_RESPONSE';
/** Plugins newer than this accept the session response through the environment variable. */
export const ENV_VAR_MIN_VERSION = '1.2.497.0';
export const RECOMMENDED_MIN_VERSION = '1.2.764.0';
const PLUGIN_NAME = 'session-manager-plugin';

export function pluginFileNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${PLUGIN_NAME}.exe`, `${PLUGIN_NAME}.cmd`, PLUGIN_NAME] : [PLUGIN_NAME];
}

export function findPluginPath(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}): string | null {
  const override = input.env.SSM_COMMANDER_PLUGIN_PATH;
  if (override) {
    if (input.exists(override)) return override;
    // A stale variable would otherwise be ignored in silence and another plugin used in its place.
    throw new CliError(
      `SSM_COMMANDER_PLUGIN_PATH points to "${override}", which does not exist`,
      'Fix or unset the variable; without it session-manager-plugin is looked up on PATH',
    );
  }
  const win = input.platform === 'win32';
  const pathModule = win ? path.win32 : path.posix;
  const searchPath = input.env.PATH ?? input.env.Path ?? '';
  for (const dir of searchPath.split(win ? ';' : ':').filter(Boolean)) {
    for (const name of pluginFileNames(input.platform)) {
      const candidate = pathModule.join(dir, name);
      if (input.exists(candidate)) return candidate;
    }
  }
  return null;
}

export function parseVersionOutput(output: string): string | null {
  return output.match(/\d+(\.\d+){1,3}/)?.[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function getPluginVersion(pluginPath: string, exec: typeof execFile = execFile): Promise<string | null> {
  return new Promise((resolve) => {
    exec(pluginPath, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      resolve(parseVersionOutput(`${stdout}\n${stderr}`));
    });
  });
}

export interface PluginInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Mirrors the argv the AWS CLI hands to session-manager-plugin for StartSession. */
export function buildPluginInvocation(input: {
  session: SessionStart;
  region: string;
  profile: string;
  parameters: StartSessionInput;
  endpoint: string;
  pluginVersion: string | null;
  baseEnv: NodeJS.ProcessEnv;
}): PluginInvocation {
  const sessionJson = JSON.stringify(input.session);
  // Unknown version: assume a current plugin so the token stays out of the process list by default.
  const useEnvVar = input.pluginVersion === null || compareVersions(input.pluginVersion, ENV_VAR_MIN_VERSION) > 0;
  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  if (useEnvVar) env[PLUGIN_ENV_VAR] = sessionJson;
  return {
    args: [
      useEnvVar ? PLUGIN_ENV_VAR : sessionJson,
      input.region,
      'StartSession',
      input.profile,
      JSON.stringify(input.parameters),
      input.endpoint,
    ],
    env,
  };
}

export { IGNORED_SIGNALS_POSIX, IGNORED_SIGNALS_WIN32 } from './spawn-inherited.js';

export type RunPluginDeps = SpawnInheritedDeps;

/** Hands the terminal to session-manager-plugin; a missing plugin becomes PluginNotFoundError. */
export async function runPlugin(
  pluginPath: string,
  invocation: PluginInvocation,
  deps: RunPluginDeps = {},
): Promise<number> {
  try {
    return await spawnInherited(pluginPath, invocation.args, invocation.env, deps);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PluginNotFoundError();
    throw err;
  }
}
