import { describe, expect, test } from 'vitest';
import { isInstanceId, resolveTarget } from '../src/target.js';
import type { InstanceRow } from '../src/types.js';

const row = (over: Partial<InstanceRow>): InstanceRow => ({
  instanceId: 'i-x',
  name: 'x',
  state: 'running',
  ssm: 'Online',
  instanceType: null,
  privateIp: null,
  publicIp: null,
  platform: null,
  connectable: true,
  reason: null,
  ...over,
});

const web1 = row({ instanceId: 'i-1', name: 'web' });
const web2 = row({ instanceId: 'i-2', name: 'web' });
const db = row({ instanceId: 'i-3', name: 'db', connectable: false, reason: 'stopped' });
const dash = row({ instanceId: 'i-4', name: 'web-1' });
const rows = [web1, web2, db, dash];

describe('isInstanceId', () => {
  test('accepts i- and mi- ids and rejects names', () => {
    expect(isInstanceId('i-0ec9249f1036e0463')).toBe(true);
    expect(isInstanceId('mi-0123456789abcdef0')).toBe(true);
    expect(isInstanceId('web')).toBe(false);
    expect(isInstanceId('i-xyz')).toBe(false);
  });
});

describe('resolveTarget', () => {
  test('exact instance id', () => {
    expect(resolveTarget('i-2', rows)).toEqual({ kind: 'resolved', row: web2 });
  });

  test('unique name', () => {
    expect(resolveTarget('web-1', rows)).toEqual({ kind: 'resolved', row: dash });
  });

  test('ambiguous name returns all matching rows', () => {
    expect(resolveTarget('web', rows)).toEqual({ kind: 'ambiguous', rows: [web1, web2] });
  });

  test('not found', () => {
    expect(resolveTarget('nothing', rows)).toEqual({ kind: 'not-found' });
    expect(resolveTarget('i-999', rows)).toEqual({ kind: 'not-found' });
  });

  test('unique but not connectable (by name or by id)', () => {
    expect(resolveTarget('db', rows)).toEqual({ kind: 'not-connectable', row: db });
    expect(resolveTarget('i-3', rows)).toEqual({ kind: 'not-connectable', row: db });
  });

  test('a name matches ignoring case when nothing matches exactly; prefixes never match', () => {
    expect(resolveTarget('WEB-1', rows)).toEqual({ kind: 'resolved', row: dash });
    expect(resolveTarget('Web', rows)).toEqual({ kind: 'ambiguous', rows: [web1, web2] });
    expect(resolveTarget('we', rows)).toEqual({ kind: 'not-found' });
  });

  test('an exact match wins over names that differ only in case', () => {
    const upper = row({ instanceId: 'i-5', name: 'Web' });
    expect(resolveTarget('Web', [web1, upper])).toEqual({ kind: 'resolved', row: upper });
    expect(resolveTarget('web', [web1, upper])).toEqual({ kind: 'resolved', row: web1 });
    expect(resolveTarget('WEB', [web1, upper])).toEqual({ kind: 'ambiguous', rows: [web1, upper] });
  });
});
