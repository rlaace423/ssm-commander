import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { configDir, readJsonFile, writeJsonFile } from '../../src/storage/paths.js';

const tmp = () => mkdtemp(join(tmpdir(), 'ssmc-'));

describe('configDir', () => {
  test('honours SSM_COMMANDER_HOME', () => {
    expect(configDir({ SSM_COMMANDER_HOME: '/tmp/x' })).toBe('/tmp/x');
  });

  test('defaults to ~/.ssm-commander', () => {
    expect(configDir({})).toBe(join(homedir(), '.ssm-commander'));
  });
});

describe('readJsonFile / writeJsonFile', () => {
  test('readJsonFile returns null for a missing file', async () => {
    expect(await readJsonFile(join(await tmp(), 'nope.json'))).toBeNull();
  });

  test('readJsonFile throws for malformed JSON', async () => {
    const file = join(await tmp(), 'bad.json');
    await writeFile(file, '{not json');
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(SyntaxError);
  });

  test('writeJsonFile creates dir 0700 and file 0600 and round-trips', async () => {
    const dir = join(await tmp(), 'nested');
    const file = join(dir, 'data.json');
    await writeJsonFile(file, { a: 1 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readJsonFile<{ a: number }>(file)).toEqual({ a: 1 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 });
  });
});
