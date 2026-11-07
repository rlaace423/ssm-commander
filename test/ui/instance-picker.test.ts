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
    expect(choices[1]?.disabled).toBe('(stopped)');
    expect(choices[1]?.value).toBe(rows[1]);
    expect(choices[2]?.name.startsWith('│       │ i-3 ')).toBe(true);
  });

  test('header contains all seven column titles', () => {
    const { header, footer } = buildInstanceChoices([], []);
    expect(INSTANCE_COLUMNS.map((c) => c.header)).toEqual([
      'Name',
      'Instance Id',
      'State',
      'SSM',
      'Type',
      'Private IP',
      'Public IP',
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
