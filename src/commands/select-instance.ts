import { CliError } from '../errors.js';
import { resolveTarget } from '../target.js';
import type { InstanceRow } from '../types.js';

export interface SelectInstanceDeps {
  pickInstance: (rows: InstanceRow[], opts: { message: string; recentIds: string[] }) => Promise<InstanceRow>;
  info: (message: string) => void;
}

/**
 * Shared target handling for every command: an explicit target is resolved against all rows,
 * while the interactive picker only ever shows `pickRows` (which may be filtered to connectable ones).
 */
export async function selectInstance(
  target: string | undefined,
  rows: InstanceRow[],
  pickRows: InstanceRow[],
  opts: { message: string; recentIds: string[] },
  deps: SelectInstanceDeps,
): Promise<InstanceRow> {
  if (target === undefined) return deps.pickInstance(assertSomethingToPick(rows, pickRows), opts);

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
    case 'not-found':
      deps.info(`No instance named "${target}"; choose from the list`);
      return deps.pickInstance(assertSomethingToPick(rows, pickRows), opts);
  }
}

/** `--connectable` can hide every row; say so instead of claiming the account has no instances. */
function assertSomethingToPick(rows: InstanceRow[], pickRows: InstanceRow[]): InstanceRow[] {
  if (pickRows.length === 0 && rows.length > 0) {
    throw new CliError(`No connectable instances (${rows.length} listed); run without --connectable to see them`);
  }
  return pickRows;
}
