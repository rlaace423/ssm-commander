import type { InstanceRow } from './types.js';

export type TargetResolution =
  | { kind: 'resolved'; row: InstanceRow }
  | { kind: 'ambiguous'; rows: InstanceRow[] }
  | { kind: 'not-found' }
  | { kind: 'not-connectable'; row: InstanceRow };

const INSTANCE_ID = /^(i|mi)-[0-9a-f]+$/;

export function isInstanceId(query: string): boolean {
  return INSTANCE_ID.test(query);
}

function single(row: InstanceRow): TargetResolution {
  return row.connectable ? { kind: 'resolved', row } : { kind: 'not-connectable', row };
}

/**
 * Resolve a user-supplied target: an exact instance id, then an exact Name tag, then a Name tag that differs only
 * in case (the table search ignores case too). Prefixes and partial names never match.
 */
export function resolveTarget(query: string, rows: InstanceRow[]): TargetResolution {
  const byId = rows.find((r) => r.instanceId === query);
  if (byId) return single(byId);
  const exact = rows.filter((r) => r.name === query);
  const lower = query.toLowerCase();
  const byName = exact.length > 0 ? exact : rows.filter((r) => r.name?.toLowerCase() === lower);
  if (byName.length === 0) return { kind: 'not-found' };
  if (byName.length === 1) return single(byName[0] as InstanceRow);
  return { kind: 'ambiguous', rows: byName };
}
