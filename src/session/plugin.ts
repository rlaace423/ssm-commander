import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { PluginNotFoundError } from '../errors.js';
import type { SessionStart, StartSessionInput } from '../types.js';

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
  if (override && input.exists(override)) return override;
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
  const useEnvVar = input.pluginVersion !== null && compareVersions(input.pluginVersion, ENV_VAR_MIN_VERSION) > 0;
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

export const IGNORED_SIGNALS_POSIX: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTSTP'];
export const IGNORED_SIGNALS_WIN32: NodeJS.Signals[] = ['SIGINT'];
/** Termination requests aimed at us are passed on to the plugin so it never outlives us. */
const FORWARDED_SIGNALS_POSIX: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];

export interface RunPluginDeps {
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
  proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;
}

/**
 * Hands the terminal to session-manager-plugin. The parent ignores the keyboard signals so
 * Ctrl+C reaches only the plugin (which forwards it to the remote shell), exactly like the AWS CLI.
 */
export async function runPlugin(
  pluginPath: string,
  invocation: PluginInvocation,
  deps: RunPluginDeps = {},
): Promise<number> {
  const spawnFn = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const proc = deps.proc ?? process;
  const ignored = platform === 'win32' ? IGNORED_SIGNALS_WIN32 : IGNORED_SIGNALS_POSIX;
  const forwarded = platform === 'win32' ? [] : FORWARDED_SIGNALS_POSIX;

  return new Promise<number>((resolve, reject) => {
    const child = spawnFn(pluginPath, invocation.args, { stdio: 'inherit', env: invocation.env });
    const ignore = () => {};
    const forwarders = forwarded.map((signal) => {
      const handler = () => {
        child.kill(signal);
        proc.exit(1);
      };
      return [signal, handler] as const;
    });
    for (const signal of ignored) proc.on(signal, ignore);
    for (const [signal, handler] of forwarders) proc.on(signal, handler);

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const signal of ignored) proc.off(signal, ignore);
      for (const [signal, handler] of forwarders) proc.off(signal, handler);
      fn();
    };
    child.once('error', (err: NodeJS.ErrnoException) =>
      finish(() => reject(err.code === 'ENOENT' ? new PluginNotFoundError() : err)),
    );
    child.once('exit', (code) => finish(() => resolve(code ?? 1)));
  });
}
