import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { createTable } from '../../src/ui/table.js';

describe('createTable', () => {
  test('pads cells to the widest display width (Korean characters count as width 2)', () => {
    const t = createTable([{ key: 'name', header: 'Name' }], [{ name: '웹서버' }, { name: 'ab' }], (r, k) =>
      String(r[k]),
    );
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
