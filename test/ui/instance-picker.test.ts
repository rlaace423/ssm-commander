import { describe, expect, test } from 'vitest';
import type { InstanceRow } from '../../src/types.js';
import { buildInstanceChoices, INSTANCE_COLUMNS, matchesTerm } from '../../src/ui/instance-picker.js';

const row = (over: Partial<InstanceRow>): InstanceRow => ({
  instanceId: 'i-x',
  name: 'x',
  state: 'running',
  ssm: 'Online',
  instanceType: 't4g.small',
  privateIp: '10.0.0.1',
  publicIp: null,
  platform: null,
  connectable: true,
  reason: null,
  ...over,
});

describe('buildInstanceChoices', () => {
  test('marks recent rows with * and disables non-connectable rows with "(reason)"', () => {
    const rows = [
      row({ instanceId: 'i-1', name: 'web' }),
      row({ instanceId: 'i-2', name: 'db', connectable: false, reason: 'stopped', state: 'stopped' }),
      row({ instanceId: 'i-3', name: null }),
    ];
    const { choices } = buildInstanceChoices(rows, ['i-1']);
    expect(choices[0]?.name.startsWith('│ * web │ i-1 ')).toBe(true);
    expect(choices[0]?.disabled).toBeUndefined();
    expect(choices[1]?.name.startsWith('│ db    │ i-2 ')).toBe(true);
    expect(choices[1]?.name.endsWith(' stopped │')).toBe(true);
    expect(choices[1]?.disabled).toBe(true);
    expect(choices[0]?.name.endsWith('│         │')).toBe(true); // empty Note cell, width of 'stopped'
    expect(choices[1]?.value).toBe(rows[1]);
    expect(choices[2]?.name.startsWith('│       │ i-3 ')).toBe(true);
  });

  test('header contains all column titles including the Note column for the reason', () => {
    const { header, footer } = buildInstanceChoices([], []);
    expect(INSTANCE_COLUMNS.map((c) => c.header)).toEqual([
      'Name',
      'Instance Id',
      'State',
      'SSM',
      'Type',
      'Private IP',
      'Public IP',
      'Note',
    ]);
    for (const column of INSTANCE_COLUMNS) expect(header).toContain(column.header);
    expect(footer.startsWith('└')).toBe(true);
  });
});

describe('matchesTerm', () => {
  test('is case-insensitive and matches name, instance id, private and public ip; empty term matches everything', () => {
    const r = row({ instanceId: 'i-0abc', name: 'Web-Server', privateIp: '10.0.1.5', publicIp: '3.3.3.3' });
    expect(matchesTerm(r, '')).toBe(true);
    expect(matchesTerm(r, 'web-s')).toBe(true);
    expect(matchesTerm(r, 'I-0ABC')).toBe(true);
    expect(matchesTerm(r, '10.0.1')).toBe(true);
    expect(matchesTerm(r, '3.3.3')).toBe(true);
    expect(matchesTerm(r, 'nope')).toBe(false);
    expect(matchesTerm(row({ name: null, instanceId: 'i-1', privateIp: null, publicIp: null }), 'x')).toBe(false);
  });
});

describe('buildInstanceChoices in a narrow terminal', () => {
  const rows = [row({ instanceId: 'i-1', name: 'web', publicIp: '3.3.3.3' })];
  const headerOf = (maxWidth?: number) => buildInstanceChoices(rows, [], maxWidth).header;

  test('drops Public IP first, then Type, then Private IP; Name, Instance Id, State, SSM and Note stay', () => {
    const full = headerOf();
    expect(full).toContain('Public IP');
    const wide = headerOf(75);
    expect(wide).not.toContain('Public IP');
    expect(wide).toContain('Type');
    const narrow = headerOf(60);
    for (const gone of ['Public IP', 'Type', 'Private IP']) expect(narrow).not.toContain(gone);
    for (const kept of ['Name', 'Instance Id', 'State', 'SSM', 'Note']) expect(narrow).toContain(kept);
  });
});
