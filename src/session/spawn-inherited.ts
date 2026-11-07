import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { CliError } from '../errors.js';

export const IGNORED_SIGNALS_POSIX: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTSTP'];
export const IGNORED_SIGNALS_WIN32: NodeJS.Signals[] = ['SIGINT'];
/** Termination requests aimed at us are passed on to the child so it never outlives us. */
const FORWARDED_SIGNALS_POSIX: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SpawnInheritedDeps {
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;
}

/**
 * Hands the terminal to a child process. The parent ignores the keyboard signals so Ctrl+C reaches
 * only the child (which decides what to do with it), exactly like the AWS CLI does for its plugin.
 * Rejects with the raw spawn error (e.g. code ENOENT) so callers can name the missing executable.
 */
export function spawnInherited(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  deps: SpawnInheritedDeps = {},
): Promise<number> {
  const spawnFn = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const proc = deps.proc ?? process;
  const ignored = platform === 'win32' ? IGNORED_SIGNALS_WIN32 : IGNORED_SIGNALS_POSIX;
  const forwarded = platform === 'win32' ? [] : FORWARDED_SIGNALS_POSIX;

  return new Promise<number>((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: 'inherit', env });
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
    child.once('error', (err: NodeJS.ErrnoException) => finish(() => reject(err)));
    child.once('exit', (code) => finish(() => resolve(code ?? 1)));
  });
}

/** Runs a system tool (ssh, scp) with the terminal attached; a missing binary becomes a CliError. */
export async function runExternal(command: string, args: string[], deps: SpawnInheritedDeps = {}): Promise<number> {
  try {
    return await spawnInherited(command, args, undefined, deps);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`${command} was not found on PATH`);
    throw err;
  }
}
