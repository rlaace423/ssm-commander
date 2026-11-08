import { spawn } from 'node:child_process';
import { filterConnectable, listInstances } from '../aws/instances.js';
import { resolveContext } from '../context.js';
import {
  assertOwnOptionsFirst,
  assertSshPortIsNumber,
  assertSshTargetFirst,
  buildProxyCommand,
  buildSshArgs,
  defaultSshUser,
  selfCommand,
  splitSshRest,
  splitUserAtTarget,
} from '../passthrough.js';
import { runExternal, type SpawnFn } from '../session/spawn-inherited.js';
import { type HistoryFile, loadHistory, recentInstanceIds } from '../storage/history.js';
import { configDir } from '../storage/paths.js';
import type { AwsContext, InstanceRow } from '../types.js';
import { PICK_INSTANCE_NEED, pickInstance } from '../ui/instance-picker.js';
import { info, type Spinner, spinner, warn } from '../ui/output.js';
import { requireTty, type TtyNeed } from '../ui/prompts.js';
import { fetchInstances } from './connect.js';
import { rowsOrTrustedId, selectInstance } from './select-instance.js';

/** ssh's exit code for its own errors (connection, authentication); remote commands return 0-254. */
const SSH_FAILURE = 255;

export interface SshOptions {
  profile?: string;
  region?: string;
  user?: string;
  identity?: string;
  port?: number;
  connectable?: boolean;
}

export interface SshDeps {
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  listInstances: (
    ctx: AwsContext,
    opts: { recentIds: string[]; connectableOnly: boolean },
  ) => Promise<{ rows: InstanceRow[]; ssmUnavailable: boolean }>;
  pickInstance: (rows: InstanceRow[], opts: { message: string; recentIds: string[] }) => Promise<InstanceRow>;
  loadHistory: (dir: string) => Promise<HistoryFile>;
  configDir: string;
  spawn: SpawnFn;
  selfCommand: () => string[];
  info: (message: string) => void;
  warn: (message: string) => void;
  spinner: (text: string) => Spinner;
  requireTty: (need?: TtyNeed) => void;
}

export function defaultSshDeps(): SshDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    listInstances: (ctx, opts) => listInstances(ctx, opts),
    pickInstance,
    loadHistory,
    configDir: configDir(),
    spawn,
    selfCommand: () => selfCommand(),
    info,
    warn,
    spinner,
    requireTty: (need) => requireTty(need),
  };
}

/** Shared by ssh and scp: resolve the AWS context and the instance to go through. */
export async function prepareTarget(
  target: string | undefined,
  opts: SshOptions,
  message: string,
  deps: SshDeps,
): Promise<{ ctx: AwsContext; row: InstanceRow; proxyCommand: string }> {
  if (target === undefined) deps.requireTty(PICK_INSTANCE_NEED); // fail before any AWS call
  const ctx = await deps.resolveContext({ profile: opts.profile, region: opts.region });
  const recentIds = recentInstanceIds(await deps.loadHistory(deps.configDir), ctx.profile, ctx.region);
  const listing = await rowsOrTrustedId(target, () => fetchInstances(ctx, recentIds, deps), deps.warn);
  const pickRows = opts.connectable ? filterConnectable(listing.rows) : listing.rows;
  const row =
    listing.trusted ??
    (await selectInstance(
      target,
      listing.rows,
      pickRows,
      { message, recentIds, profile: ctx.profile, region: ctx.region },
      deps,
    ));
  const proxyCommand = buildProxyCommand(deps.selfCommand(), {
    profile: ctx.profile,
    region: ctx.region,
    instanceId: row.instanceId,
    port: opts.port ?? 22,
  });
  return { ctx, row, proxyCommand };
}

export async function runSsh(args: string[], opts: SshOptions, deps: SshDeps = defaultSshDeps()): Promise<number> {
  const [first, ...rest] = args;
  if (first !== undefined) assertSshTargetFirst(first);
  const { user: userAtTarget, target } = splitUserAtTarget(first);
  // Only the ssh options before the remote command are checked; the remote command may use any flags it likes.
  const sshOptions = splitSshRest(rest).options;
  assertOwnOptionsFirst(sshOptions);
  assertSshPortIsNumber(sshOptions);

  const { row, proxyCommand } = await prepareTarget(target, opts, 'Select an instance to ssh into', deps);
  const explicitUser = userAtTarget ?? opts.user;
  const user = explicitUser ?? defaultSshUser(row.platform);
  const sshArgs = buildSshArgs({
    own: { user, identity: opts.identity, port: opts.port },
    instanceId: row.instanceId,
    proxyCommand,
    rest,
  });
  deps.info(`Opening ssh to ${row.name ?? row.instanceId} (${row.instanceId}) through Session Manager...`);
  const code = await runExternal('ssh', sshArgs, { spawn: deps.spawn });
  if (code === SSH_FAILURE && explicitUser === undefined) {
    // 255 is ssh's own failure (not the remote command's); a wrong login name is the usual first-time cause.
    const why = row.platform === null ? 'the default when the platform is unknown' : `the default for ${row.platform}`;
    deps.info(
      `  hint: ssh used the login name "${user}" (${why}); pass --user <name> or <name>@${target} to use another`,
    );
  }
  return code;
}
