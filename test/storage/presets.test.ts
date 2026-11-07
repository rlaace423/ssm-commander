import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CliError } from '../../src/errors.js';
import {
  emptyPresets,
  type ForwardPreset,
  findPreset,
  loadPresets,
  removePreset,
  savePresets,
  upsertPreset,
} from '../../src/storage/presets.js';

const web: ForwardPreset = {
  name: 'web-ssh',
  profile: 'default',
  region: 'ap-northeast-2',
  instanceId: 'i-web',
  instanceName: 'web',
  remoteHost: 'localhost',
  remotePort: 22,
  localPort: 2222,
};
const db: ForwardPreset = { ...web, name: 'db', remoteHost: 'db.internal', remotePort: 5432, localPort: 15432 };

describe('upsertPreset', () => {
  test('appends a new preset and replaces an existing one by name', () => {
    let file = upsertPreset(emptyPresets(), web);
    file = upsertPreset(file, db);
    expect(file.presets.map((p) => p.name)).toEqual(['web-ssh', 'db']);
    file = upsertPreset(file, { ...web, localPort: 3333 });
    expect(file.presets.map((p) => p.name)).toEqual(['web-ssh', 'db']);
    expect(file.presets[0]?.localPort).toBe(3333);
  });
});

describe('removePreset', () => {
  test('removes by name and leaves the file unchanged for an unknown name', () => {
    const file = upsertPreset(upsertPreset(emptyPresets(), web), db);
    expect(removePreset(file, 'web-ssh').presets.map((p) => p.name)).toEqual(['db']);
    expect(removePreset(file, 'nope')).toEqual(file);
  });
});

describe('findPreset', () => {
  test('returns the preset or undefined', () => {
    const file = upsertPreset(emptyPresets(), web);
    expect(findPreset(file, 'web-ssh')).toEqual(web);
    expect(findPreset(file, 'nope')).toBeUndefined();
  });
});

describe('loadPresets / savePresets', () => {
  test('loadPresets fails with a CliError that names the file when it is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ssmc-'));
    await writeFile(join(dir, 'presets.json'), '{ nope');
    await expect(loadPresets(dir)).rejects.toBeInstanceOf(CliError);
    await expect(loadPresets(dir)).rejects.toThrow(join(dir, 'presets.json'));
  });

  test('loadPresets returns emptyPresets() when missing; savePresets/loadPresets round-trip', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'ssmc-')), 'home');
    expect(await loadPresets(dir)).toEqual(emptyPresets());
    const file = upsertPreset(emptyPresets(), web);
    await savePresets(dir, file);
    expect(await loadPresets(dir)).toEqual(file);
  });
});
