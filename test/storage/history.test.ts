import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  emptyHistory,
  HISTORY_LIMIT,
  type HistoryEntry,
  loadHistory,
  recentEcsTargets,
  recentInstanceIds,
  recordConnection,
  recordExec,
  saveHistory,
} from '../../src/storage/history.js';

const now = new Date('2026-11-07T00:00:00Z');
const web = { profile: 'default', region: 'ap-northeast-2', instanceId: 'i-web', instanceName: 'web' };
const db = { ...web, instanceId: 'i-db', instanceName: 'db' };
const api = { profile: 'default', region: 'ap-northeast-2', cluster: 'prod', service: 'api' };
const tmp = () => mkdtemp(join(tmpdir(), 'ssmc-'));
/** The instance id of an EC2 entry, the service of an ECS one: enough to tell the entries apart in a list. */
const keyOf = (e: HistoryEntry) => (e.kind === 'ecs' ? e.service : e.instanceId);

describe('recordConnection', () => {
  test('adds a new entry at the front with count 1 and ISO timestamp', () => {
    const file = recordConnection(emptyHistory(), web, now);
    expect(file.entries).toEqual([{ ...web, lastConnectedAt: '2026-11-07T00:00:00.000Z', count: 1 }]);
  });

  test('merges same profile/region/instanceId: count increments, entry moves to front, name updated', () => {
    let file = recordConnection(emptyHistory(), web, now);
    file = recordConnection(file, db, now);
    const later = new Date('2026-11-08T00:00:00Z');
    file = recordConnection(file, { ...web, instanceName: 'web-renamed' }, later);
    expect(file.entries.map(keyOf)).toEqual(['i-web', 'i-db']);
    expect(file.entries[0]).toMatchObject({
      count: 2,
      instanceName: 'web-renamed',
      lastConnectedAt: later.toISOString(),
    });
  });

  test('keeps at most HISTORY_LIMIT entries, dropping the oldest', () => {
    let file = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      file = recordConnection(file, { ...web, instanceId: `i-${i}` }, now);
    }
    expect(file.entries).toHaveLength(HISTORY_LIMIT);
    expect(file.entries[0]).toMatchObject({ instanceId: `i-${HISTORY_LIMIT + 4}` });
    expect(file.entries.at(-1)).toMatchObject({ instanceId: 'i-5' });
  });
});

describe('recordExec (ECS entries share the file with EC2 entries)', () => {
  test('adds an ecs entry at the front with count 1 and ISO timestamp', () => {
    const file = recordExec(recordConnection(emptyHistory(), web, now), api, now);
    expect(file.entries[0]).toEqual({ kind: 'ecs', ...api, lastConnectedAt: '2026-11-07T00:00:00.000Z', count: 1 });
    expect(file.entries).toHaveLength(2);
  });

  test('merges the same profile/region/cluster/service and keeps other services and standalone tasks apart', () => {
    let file = recordExec(emptyHistory(), api, now);
    file = recordExec(file, { ...api, service: 'worker' }, now);
    file = recordExec(file, { ...api, service: null }, now);
    const later = new Date('2026-11-08T00:00:00Z');
    file = recordExec(file, api, later);
    expect(file.entries.map(keyOf)).toEqual(['api', null, 'worker']);
    expect(file.entries[0]).toMatchObject({ count: 2, lastConnectedAt: later.toISOString() });
  });

  test('ecs and ec2 entries count towards the same limit', () => {
    let file = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT; i++) file = recordConnection(file, { ...web, instanceId: `i-${i}` }, now);
    file = recordExec(file, api, now);
    expect(file.entries).toHaveLength(HISTORY_LIMIT);
    expect(file.entries[0]).toMatchObject({ kind: 'ecs', cluster: 'prod' });
    expect(file.entries.at(-1)).toMatchObject({ instanceId: 'i-1' });
  });
});

describe('recentEcsTargets', () => {
  test('returns cluster/service pairs of the given profile/region only, most recent first, skipping ec2 entries', () => {
    let file = recordExec(emptyHistory(), api, now);
    file = recordConnection(file, web, now);
    file = recordExec(file, { ...api, profile: 'other' }, now);
    file = recordExec(file, { ...api, region: 'us-east-1', cluster: 'us' }, now);
    file = recordExec(file, { ...api, cluster: 'batch', service: null }, now);
    expect(recentEcsTargets(file, 'default', 'ap-northeast-2')).toEqual([
      { cluster: 'batch', service: null },
      { cluster: 'prod', service: 'api' },
    ]);
  });
});

describe('recentInstanceIds', () => {
  test('skips ecs entries', () => {
    const file = recordExec(recordConnection(emptyHistory(), web, now), api, now);
    expect(recentInstanceIds(file, 'default', 'ap-northeast-2')).toEqual(['i-web']);
  });

  test('returns ids of the given profile/region only, most recent first', () => {
    let file = recordConnection(emptyHistory(), web, now);
    file = recordConnection(file, { ...web, profile: 'other', instanceId: 'i-other' }, now);
    file = recordConnection(file, { ...web, region: 'us-east-1', instanceId: 'i-us' }, now);
    file = recordConnection(file, db, now);
    expect(recentInstanceIds(file, 'default', 'ap-northeast-2')).toEqual(['i-db', 'i-web']);
  });
});

describe('loadHistory / saveHistory', () => {
  test('loadHistory returns emptyHistory() when the file is missing', async () => {
    expect(await loadHistory(await tmp())).toEqual(emptyHistory());
  });

  test('loadHistory ignores a file with an unknown version', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'history.json'), JSON.stringify({ version: 99, entries: [{ bogus: true }] }));
    expect(await loadHistory(dir)).toEqual(emptyHistory());
  });

  test('loadHistory warns with the file path and continues with an empty history when the file is corrupt', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'history.json'), '{ definitely not json');
    const warn = vi.fn();
    expect(await loadHistory(dir, { warn })).toEqual(emptyHistory());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(join(dir, 'history.json'));
  });

  test('saveHistory then loadHistory round-trips in a temp dir', async () => {
    const dir = join(await tmp(), 'home');
    const file = recordExec(recordConnection(emptyHistory(), web, now), api, now);
    await saveHistory(dir, file);
    expect(await loadHistory(dir)).toEqual(file);
  });
});
