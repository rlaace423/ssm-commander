import { render } from '@inquirer/testing';
import { describe, expect, test, vi } from 'vitest';
import { tableSearch } from '../../src/ui/table-search.js';

const all = [
  { name: '│ alpha │ i-1 │', value: 1 },
  { name: '│ beta  │ i-2 │', value: 2 },
];
const base = { message: 'Pick', header: 'HEADER-LINE', footer: 'FOOTER-LINE' };

describe('tableSearch', () => {
  test('renders header, rows and footer and returns the active value on Enter', async () => {
    const { answer, events, getScreen } = await render(tableSearch, { ...base, source: () => all });
    await vi.waitFor(() => expect(getScreen()).toContain('beta'));
    const screen = getScreen();
    expect(screen).toContain('HEADER-LINE');
    expect(screen).toContain('FOOTER-LINE');
    expect(screen.indexOf('HEADER-LINE')).toBeLessThan(screen.indexOf('alpha'));
    expect(screen.indexOf('beta')).toBeLessThan(screen.indexOf('FOOTER-LINE'));
    events.keypress('down');
    events.keypress('enter');
    expect(await answer).toBe(2);
    expect(getScreen()).toContain('Pick beta');
  });

  test('typing filters through source and shows "No results found" for no match', async () => {
    const source = vi.fn((term: string | undefined) => all.filter((c) => c.name.includes(term ?? '')));
    const { answer, events, getScreen } = await render(tableSearch, { ...base, source });
    await vi.waitFor(() => expect(getScreen()).toContain('alpha'));
    events.type('bet');
    await vi.waitFor(() => expect(getScreen()).not.toContain('alpha'));
    expect(getScreen()).toContain('beta');
    events.type('zzz');
    await vi.waitFor(() => expect(getScreen()).toContain('No results found'));
    expect(source).toHaveBeenLastCalledWith('betzzz');
    answer.catch(() => {});
    events.keypress({ name: 'c', ctrl: true });
  });

  test('cursor skips disabled rows and Enter on a disabled-only list does nothing', async () => {
    const mixed = [
      { name: 'alpha', value: 1, disabled: '(stopped)' },
      { name: 'beta', value: 2 },
      { name: 'gamma', value: 3, disabled: true },
    ];
    const first = await render(tableSearch, { ...base, source: () => mixed });
    await vi.waitFor(() => expect(first.getScreen()).toContain('gamma'));
    expect(first.getScreen()).toContain('alpha (stopped)');
    first.events.keypress('down');
    first.events.keypress('up');
    first.events.keypress('enter');
    expect(await first.answer).toBe(2);

    const onlyDisabled = await render(tableSearch, { ...base, source: () => [mixed[0] as (typeof mixed)[number]] });
    await vi.waitFor(() => expect(onlyDisabled.getScreen()).toContain('alpha'));
    onlyDisabled.events.keypress('enter');
    const outcome = await Promise.race([
      onlyDisabled.answer.then(() => 'answered'),
      new Promise((r) => setTimeout(() => r('pending'), 60)),
    ]);
    expect(outcome).toBe('pending');
    onlyDisabled.answer.catch(() => {});
    onlyDisabled.events.keypress({ name: 'c', ctrl: true });
  });
});
