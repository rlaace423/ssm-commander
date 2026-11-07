import { describe, expect, test } from 'vitest';
import { PluginNotFoundError } from '../../src/errors.js';
import { IGNORED_SIGNALS_POSIX, IGNORED_SIGNALS_WIN32, runPlugin } from '../../src/session/plugin.js';

describe('runPlugin', () => {
  test('signal lists', () => {
    expect(IGNORED_SIGNALS_POSIX).toEqual(['SIGINT', 'SIGQUIT', 'SIGTSTP']);
    expect(IGNORED_SIGNALS_WIN32).toEqual(['SIGINT']);
  });

  test('resolves with the child exit code', async () => {
    expect(await runPlugin(process.execPath, { args: ['-e', 'process.exit(3)'], env: process.env })).toBe(3);
  });

  test('ignores SIGINT in the parent while the child runs and restores afterwards', async () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGQUIT: process.listenerCount('SIGQUIT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
    };
    const running = runPlugin(
      process.execPath,
      { args: ['-e', 'setTimeout(() => process.exit(0), 300)'], env: process.env },
      { platform: 'linux' },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGQUIT')).toBe(before.SIGQUIT + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1);
    expect(await running).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGQUIT')).toBe(before.SIGQUIT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP);
  });

  test('on win32 only SIGINT is ignored and nothing is forwarded', async () => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const running = runPlugin(
      process.execPath,
      { args: ['-e', 'setTimeout(() => process.exit(0), 200)'], env: process.env },
      { platform: 'win32' },
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    await running;
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
  });

  test('rejects with PluginNotFoundError when the executable does not exist', async () => {
    const before = process.listenerCount('SIGINT');
    await expect(
      runPlugin('/nonexistent/session-manager-plugin', { args: [], env: process.env }),
    ).rejects.toBeInstanceOf(PluginNotFoundError);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
