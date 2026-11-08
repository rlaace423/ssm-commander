import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { createTable, terminalTableWidth } from '../../src/ui/table.js';

describe('createTable', () => {
  test('pads cells to the widest display width (Korean characters count as width 2)', () => {
    const rows: Record<string, string>[] = [{ name: '웹서버' }, { name: 'ab' }];
    const t = createTable([{ key: 'name', header: 'Name' }], rows, (r, k) => r[k] ?? '');
    expect(stringWidth(t.lines[0]?.text ?? '')).toBe(stringWidth(t.lines[1]?.text ?? ''));
    expect(t.lines[1]?.text).toBe('│ ab     │');
    expect(t.lines[1]?.value).toEqual({ name: 'ab' });
  });

  test('renders header and footer with box-drawing borders', () => {
    const t = createTable(
      [
        { key: 'name', header: 'Name' },
        { key: 'id', header: 'Instance Id' },
      ],
      [{ name: 'web', id: 'i-1' }] as Record<string, string>[],
      (r, k) => r[k] ?? '',
    );
    const [top, head, sep] = t.header.split('\n');
    expect(top).toBe('┌──────┬─────────────┐');
    expect(head).toBe('│ Name │ Instance Id │');
    expect(sep).toBe('├──────┼─────────────┤');
    expect(t.footer).toBe('└──────┴─────────────┘');
    expect(t.lines[0]?.text).toBe('│ web  │ i-1         │');
  });
});

describe('createTable within a maximum width', () => {
  type Row = Record<string, string>;
  const columns = [
    { key: 'name', header: 'Name', shrink: true },
    { key: 'id', header: 'Instance Id' },
    { key: 'type', header: 'Type', dropOrder: 2 },
    { key: 'ip', header: 'Public IP', dropOrder: 1 },
  ];
  const rows: Row[] = [{ name: 'a-rather-long-instance-name', id: 'i-0123456789abcdef0', type: 't3.micro', ip: '3.3.3.3' }];
  const cell = (r: Row, k: string) => r[k] ?? '';
  const full = createTable(columns, rows, cell);
  const width = (t: { header: string }) => stringWidth(t.header.split('\n')[0] ?? '');

  test('without a limit every column is kept', () => {
    expect(full.header).toContain('Public IP');
    expect(full.header).toContain('Type');
    expect(createTable(columns, rows, cell, { maxWidth: width(full) })).toEqual(full);
  });

  test('drops the droppable columns in order, lowest dropOrder first, until the table fits', () => {
    const one = createTable(columns, rows, cell, { maxWidth: width(full) - 1 });
    expect(one.header).not.toContain('Public IP');
    expect(one.header).toContain('Type');
    const two = createTable(columns, rows, cell, { maxWidth: width(one) - 1 });
    expect(two.header).not.toContain('Type');
    expect(two.header).toContain('Instance Id');
    expect(width(two)).toBeLessThan(width(one));
    for (const t of [one, two]) {
      expect(stringWidth(t.lines[0]?.text ?? '')).toBe(width(t));
      expect(stringWidth(t.footer)).toBe(width(t));
    }
  });

  test('when no column is left to drop, the shrinkable column is cut with an ellipsis to fit exactly', () => {
    const limit = 50;
    const t = createTable(columns, rows, cell, { maxWidth: limit });
    expect(width(t)).toBe(limit);
    expect(t.lines[0]?.text).toContain('…');
    expect(t.lines[0]?.text).toContain('i-0123456789abcdef0'); // only the shrink column is cut
    expect(t.lines[0]?.value).toBe(rows[0]);
  });

  test('never cuts the shrinkable column below a readable minimum, even if the table then overflows', () => {
    const t = createTable(columns, rows, cell, { maxWidth: 10 });
    expect(t.header).toContain('Name');
    expect(t.header).toContain('Instance Id');
    expect(width(t)).toBeGreaterThan(10);
    const nameCell = t.lines[0]?.text.split('│')[1]?.trim() ?? '';
    expect(stringWidth(nameCell)).toBeGreaterThanOrEqual(8);
  });

  test('terminalTableWidth leaves room for the prompt indent and is undefined without a terminal', () => {
    expect(terminalTableWidth({ columns: 100 }, 4)).toBe(96);
    expect(terminalTableWidth({}, 4)).toBeUndefined();
    expect(terminalTableWidth({ columns: 10 }, 4)).toBe(20); // a floor keeps very narrow panes from dropping everything
  });
});
