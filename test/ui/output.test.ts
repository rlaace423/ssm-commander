import { afterEach, describe, expect, test, vi } from 'vitest';
import { info, spinner, warn } from '../../src/ui/output.js';

const oraCalls: unknown[] = [];
vi.mock('ora', () => ({
  default: (options: unknown) => {
    oraCalls.push(options);
    const instance = { start: () => instance, stop: () => instance, fail: () => instance };
    return instance;
  },
}));

describe('output helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  test('info and warn write to stderr, warn with a Warning prefix', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    info('hello');
    warn('careful');
    expect(write.mock.calls[0]?.[0]).toBe('hello\n');
    expect(String(write.mock.calls[1]?.[0])).toContain('Warning: careful');
  });

  test('spinner leaves stdin alone (ora would otherwise put the terminal in raw mode and swallow Ctrl+C)', () => {
    const original = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    try {
      spinner('Fetching…').stop();
      expect(oraCalls.at(-1)).toEqual(expect.objectContaining({ text: 'Fetching…', discardStdin: false }));
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: original, configurable: true });
    }
  });

  test('spinner writes nothing when stderr is not a TTY', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const original = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    try {
      const s = spinner('Fetching…');
      s.fail('nope');
      s.stop();
      expect(write).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: original, configurable: true });
    }
  });
});
