import { filterConnectable, listInstances } from '../aws/instances.js';
import { resolveContext } from '../context.js';
import { CliError, describeAwsError, IAM_ACTIONS } from '../errors.js';
import { defaultRunSessionDeps, runSession } from '../session/run-session.js';
import { type HistoryFile, loadHistory, recentInstanceIds, recordConnection, saveHistory } from '../storage/history.js';
import { configDir } from '../storage/paths.js';
import { suggestCommand } from '../suggest.js';
import { resolveTarget } from '../target.js';
import type { AwsContext, InstanceRow, StartSessionInput } from '../types.js';
import { PICK_INSTANCE_NEED, pickInstance } from '../ui/instance-picker.js';
import { info, type Spinner, spinner, warn } from '../ui/output.js';
import { requireTty, type TtyNeed } from '../ui/prompts.js';
import { rowsOrTrustedId, selectInstance } from './select-instance.js';

export interface ConnectOptions {
  profile?: string;
  region?: string;
  connectable?: boolean;
  /** connect was implied (no command word): a target matching no instance may be a mistyped command. */
  defaultCommand?: boolean;
}

export interface ConnectDeps {
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  listInstances: (
    ctx: AwsContext,
    opts: { recentIds: string[]; connectableOnly: boolean },
  ) => Promise<{ rows: InstanceRow[]; ssmUnavailable: boolean }>;
  pickInstance: (rows: InstanceRow[], opts: { message: string; recentIds: string[] }) => Promise<InstanceRow>;
  runSession: (ctx: AwsContext, input: StartSessionInput) => Promise<number>;
  loadHistory: (dir: string) => Promise<HistoryFile>;
  saveHistory: (dir: string, file: HistoryFile) => Promise<void>;
  configDir: string;
  now: () => Date;
  warn: (message: string) => void;
  info: (message: string) => void;
  spinner: (text: string) => Spinner;
  requireTty: (need?: TtyNeed) => void;
}

export function defaultConnectDeps(): ConnectDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    listInstances: (ctx, opts) => listInstances(ctx, opts),
    pickInstance,
    runSession: (ctx, input) => runSession(ctx, input, defaultRunSessionDeps(ctx)),
    loadHistory,
    saveHistory,
    configDir: configDir(),
    now: () => new Date(),
    warn,
    info,
    spinner,
    requireTty: (need) => requireTty(need),
  };
}

export const SSM_UNAVAILABLE_WARNING =
  'Not allowed to call ssm:DescribeInstanceInformation; SSM status is unknown for all instances';

/** Lists instances for the profile/region, lets the user pick one (or resolves the target), then opens a shell. */
export async function runConnect(
  target: string | undefined,
  opts: ConnectOptions,
  deps: ConnectDeps = defaultConnectDeps(),
): Promise<number> {
  if (target === undefined) deps.requireTty(PICK_INSTANCE_NEED); // fail before any AWS call
  const ctx = await deps.resolveContext({ profile: opts.profile, region: opts.region });
  const history = await deps.loadHistory(deps.configDir);
  const recentIds = recentInstanceIds(history, ctx.profile, ctx.region);

  const listing = await rowsOrTrustedId(target, () => fetchInstances(ctx, recentIds, deps), deps.warn);
  if (listing.ssmUnavailable) deps.warn(SSM_UNAVAILABLE_WARNING);
  if (target !== undefined && listing.trusted === null && opts.defaultCommand) {
    assertNotMistypedCommand(target, listing.rows, ctx);
  }
  const pickRows = opts.connectable ? filterConnectable(listing.rows) : listing.rows;

  const row =
    listing.trusted ??
    (await selectInstance(
      target,
      listing.rows,
      pickRows,
      { message: 'Select an instance to connect', recentIds, profile: ctx.profile, region: ctx.region },
      deps,
    ));
  deps.info(
    `Connecting to ${row.name ?? row.instanceId} (${row.instanceId}) in ${ctx.region} with profile ${ctx.profile}...`,
  );

  let exitCode: number;
  try {
    exitCode = await deps.runSession(ctx, { Target: row.instanceId });
  } catch (err) {
    throw describeAwsError(err, { profile: ctx.profile, region: ctx.region, action: IAM_ACTIONS.ssmStart });
  }

  const entry = { profile: ctx.profile, region: ctx.region, instanceId: row.instanceId, instanceName: row.name };
  await deps.saveHistory(deps.configDir, recordConnection(history, entry, deps.now()));
  return exitCode;
}

/** `ssm-commander conect` reaches connect with the target "conect"; when no instance has that name, say what it looks like. */
function assertNotMistypedCommand(target: string, rows: InstanceRow[], ctx: AwsContext): void {
  const suggestion = suggestCommand(target);
  if (suggestion === null || resolveTarget(target, rows).kind !== 'not-found') return;
  throw new CliError(
    `Unknown command "${target}"`,
    `Did you mean "ssm-commander ${suggestion}"? No instance in ${ctx.region} (profile ${ctx.profile}) is named "${target}" either`,
  );
}

export async function fetchInstances(
  ctx: AwsContext,
  recentIds: string[],
  deps: Pick<ConnectDeps, 'listInstances' | 'spinner'>,
): Promise<{ rows: InstanceRow[]; ssmUnavailable: boolean }> {
  const spin = deps.spinner('Fetching instances...');
  try {
    const listing = await deps.listInstances(ctx, { recentIds, connectableOnly: false });
    spin.stop();
    return listing;
  } catch (err) {
    spin.fail('Fetching instances failed');
    throw describeAwsError(err, { profile: ctx.profile, region: ctx.region, action: IAM_ACTIONS.ec2Describe });
  }
}
