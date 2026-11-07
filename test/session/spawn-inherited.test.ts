import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { spawnInherited } from '../../src/session/spawn-inherited.js';

describe('spawnInherited termination signals', () => {
  test('forwards SIGTERM to the child and resolves with 128+signal instead of exiting the parent', async () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const running = spawnInherited(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, {
      platform: 'linux',
      proc: proc as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    });
    await new Promise((r) => setTimeout(r, 150));
    proc.emit('SIGTERM');
    expect(await running).toBe(143);
    expect(proc.exit).not.toHaveBeenCalled();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});
