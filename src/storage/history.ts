import { join } from 'node:path';
import { warn } from '../ui/output.js';
import { readJsonFile, writeJsonFile } from './paths.js';

interface HistoryBase {
  profile: string;
  region: string;
  lastConnectedAt: string;
  count: number;
}

/** An EC2 instance reached with `connect`. Files written before ECS support have no `kind`. */
export interface Ec2HistoryEntry extends HistoryBase {
  kind?: 'ec2';
  instanceId: string;
  instanceName: string | null;
}

/** An ECS service reached with `exec`; tasks are too short-lived to remember (`service` is null outside a service). */
export interface EcsHistoryEntry extends HistoryBase {
  kind: 'ecs';
  cluster: string;
  service: string | null;
}

export type HistoryEntry = Ec2HistoryEntry | EcsHistoryEntry;

export interface EcsTargetKey {
  cluster: string;
  service: string | null;
}

export interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

export const HISTORY_LIMIT = 50;
const FILE_NAME = 'history.json';

export function emptyHistory(): HistoryFile {
  return { version: 1, entries: [] };
}

const isEcs = (entry: HistoryEntry): entry is EcsHistoryEntry => entry.kind === 'ecs';

/** Moves (or adds) the matching entry to the front with the count bumped; the oldest entries fall off the end. */
function record(file: HistoryFile, isSame: (entry: HistoryEntry) => boolean, entry: HistoryEntry): HistoryFile {
  const existing = file.entries.find(isSame);
  const updated = { ...entry, count: (existing?.count ?? 0) + 1 };
  const rest = file.entries.filter((e) => !isSame(e));
  return { version: 1, entries: [updated, ...rest].slice(0, HISTORY_LIMIT) };
}

export function recordConnection(
  file: HistoryFile,
  entry: Pick<Ec2HistoryEntry, 'profile' | 'region' | 'instanceId' | 'instanceName'>,
  now: Date,
): HistoryFile {
  const isSame = (e: HistoryEntry) =>
    !isEcs(e) && e.profile === entry.profile && e.region === entry.region && e.instanceId === entry.instanceId;
  return record(file, isSame, { ...entry, lastConnectedAt: now.toISOString(), count: 0 });
}

export function recordExec(
  file: HistoryFile,
  entry: Pick<EcsHistoryEntry, 'profile' | 'region' | 'cluster' | 'service'>,
  now: Date,
): HistoryFile {
  const isSame = (e: HistoryEntry) =>
    isEcs(e) &&
    e.profile === entry.profile &&
    e.region === entry.region &&
    e.cluster === entry.cluster &&
    e.service === entry.service;
  return record(file, isSame, { kind: 'ecs', ...entry, lastConnectedAt: now.toISOString(), count: 0 });
}

export function recentInstanceIds(file: HistoryFile, profile: string, region: string): string[] {
  return file.entries
    .filter((e): e is Ec2HistoryEntry => !isEcs(e) && e.profile === profile && e.region === region)
    .map((e) => e.instanceId);
}

/** Cluster/service pairs of the profile and region, most recent first. */
export function recentEcsTargets(file: HistoryFile, profile: string, region: string): EcsTargetKey[] {
  return file.entries
    .filter((e): e is EcsHistoryEntry => isEcs(e) && e.profile === profile && e.region === region)
    .map((e) => ({ cluster: e.cluster, service: e.service }));
}

/** History is a convenience: an unreadable file is reported and ignored rather than blocking the command. */
export async function loadHistory(dir: string, deps: { warn?: (message: string) => void } = {}): Promise<HistoryFile> {
  const path = join(dir, FILE_NAME);
  let data: HistoryFile | null;
  try {
    data = await readJsonFile<HistoryFile>(path);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    (deps.warn ?? warn)(`Ignoring unreadable ${path}: ${err.message}`);
    return emptyHistory();
  }
  if (data?.version !== 1 || !Array.isArray(data.entries)) return emptyHistory();
  return data;
}

export async function saveHistory(dir: string, file: HistoryFile): Promise<void> {
  await writeJsonFile(join(dir, FILE_NAME), file);
}
