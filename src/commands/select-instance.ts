import { AccessDeniedError, CliError } from '../errors.js';
import { isInstanceId, resolveTarget } from '../target.js';
import type { InstanceRow } from '../types.js';
import { PICK_INSTANCE_NEED } from '../ui/instance-picker.js';
import type { TtyNeed } from '../ui/prompts.js';

export interface SelectInstanceDeps {
  pickInstance: (rows: InstanceRow[], opts: { message: string; recentIds: string[] }) => Promise<InstanceRow>;
  info: (message: string) => void;
  /** Throws a CliError when there is no terminal to pick from. */
  requireTty: (need?: TtyNeed) => void;
}

export interface SelectInstanceOptions {
  message: string;
  recentIds: string[];
  /** Where the rows came from, for the messages when a target is not found. */
  profile: string;
  region: string;
}

/**
 * Shared target handling for every command: an explicit target is resolved against all rows,
 * while the interactive picker only ever shows `pickRows` (which may be filtered to connectable ones).
 */
export async function selectInstance(
  target: string | undefined,
  rows: InstanceRow[],
  pickRows: InstanceRow[],
  opts: SelectInstanceOptions,
  deps: SelectInstanceDeps,
): Promise<InstanceRow> {
  const where = `in ${opts.region} (profile ${opts.profile})`;
  if (target === undefined) return deps.pickInstance(assertSomethingToPick(rows, pickRows, where), opts);

  const resolution = resolveTarget(target, rows);
  switch (resolution.kind) {
    case 'resolved':
      return resolution.row;
    case 'not-connectable': {
      const { instanceId, name, reason } = resolution.row;
      throw new CliError(`Instance ${instanceId} (${name ?? 'unnamed'}) cannot be connected: ${reason}`);
    }
    case 'ambiguous':
      deps.info(`Several instances are named "${target}"; choose one`);
      return deps.pickInstance(resolution.rows, opts);
    case 'not-found': {
      // An id is exact: offering the list would only show that it is not there.
      if (isInstanceId(target)) {
        throw new CliError(
          `Instance ${target} was not found ${where}`,
          'Instance ids belong to one region: check --region and --profile',
        );
      }
      const notFound = new CliError(
        `No instance named "${target}" ${where}`,
        'Names are matched ignoring case; check the name, the region and the profile',
      );
      if (rows.length === 0) throw new CliError(`No instances found ${where}`);
      try {
        deps.requireTty(PICK_INSTANCE_NEED); // without a terminal the list cannot be offered, so stop at the fact
      } catch {
        throw notFound;
      }
      deps.info(`${notFound.message}; choose from the list`);
      return deps.pickInstance(assertSomethingToPick(rows, pickRows, where), opts);
    }
  }
}

export interface Listing {
  rows: InstanceRow[];
  ssmUnavailable: boolean;
}

export interface ListingOrTrusted extends Listing {
  /** Set when the listing was denied and the target is an instance id, which is then used as given. */
  trusted: InstanceRow | null;
}

export function trustedRow(instanceId: string): InstanceRow {
  return {
    instanceId,
    name: null,
    state: 'unknown',
    ssm: 'unknown',
    instanceType: null,
    privateIp: null,
    publicIp: null,
    platform: null,
    connectable: true,
    reason: null,
  };
}

/**
 * The listing is a convenience (names, the connectable check). A profile that may not list instances can
 * still reach an instance id, exactly as with the AWS CLI; a Name tag needs the listing.
 */
export async function rowsOrTrustedId(
  target: string | undefined,
  list: () => Promise<Listing>,
  warn: (message: string) => void,
): Promise<ListingOrTrusted> {
  try {
    return { ...(await list()), trusted: null };
  } catch (err) {
    if (!(err instanceof AccessDeniedError) || target === undefined) throw err;
    if (!isInstanceId(target)) {
      throw new AccessDeniedError(
        err.message,
        `Pass the instance id instead of the name to connect without listing. ${err.hint ?? ''}`.trim(),
      );
    }
    warn(`${err.message}; using ${target} as given without checking it`);
    return { rows: [], ssmUnavailable: false, trusted: trustedRow(target) };
  }
}

/** `--connectable` can hide every row; say so instead of claiming the region has no instances. */
function assertSomethingToPick(rows: InstanceRow[], pickRows: InstanceRow[], where: string): InstanceRow[] {
  if (rows.length === 0) throw new CliError(`No instances found ${where}`);
  if (pickRows.length === 0) {
    throw new CliError(`No connectable instances (${rows.length} listed); run without --connectable to see them`);
  }
  return pickRows;
}
