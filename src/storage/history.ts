import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './paths.js';

export interface HistoryEntry {
  profile: string;
  region: string;
  instanceId: string;
  instanceName: string | null;
  lastConnectedAt: string;
  count: number;
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

export function recordConnection(
  file: HistoryFile,
  entry: Pick<HistoryEntry, 'profile' | 'region' | 'instanceId' | 'instanceName'>,
  now: Date,
): HistoryFile {
  const isSame = (e: HistoryEntry) =>
    e.profile === entry.profile && e.region === entry.region && e.instanceId === entry.instanceId;
  const existing = file.entries.find(isSame);
  const updated: HistoryEntry = { ...entry, lastConnectedAt: now.toISOString(), count: (existing?.count ?? 0) + 1 };
  const rest = file.entries.filter((e) => !isSame(e));
  return { version: 1, entries: [updated, ...rest].slice(0, HISTORY_LIMIT) };
}

export function recentInstanceIds(file: HistoryFile, profile: string, region: string): string[] {
  return file.entries.filter((e) => e.profile === profile && e.region === region).map((e) => e.instanceId);
}

export async function loadHistory(dir: string): Promise<HistoryFile> {
  const data = await readJsonFile<HistoryFile>(join(dir, FILE_NAME));
  if (data?.version !== 1 || !Array.isArray(data.entries)) return emptyHistory();
  return data;
}

export async function saveHistory(dir: string, file: HistoryFile): Promise<void> {
  await writeJsonFile(join(dir, FILE_NAME), file);
}
