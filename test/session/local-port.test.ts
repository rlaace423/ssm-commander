import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { CliError } from '../../src/errors.js';
import { assertLocalPortFree } from '../../src/session/local-port.js';

let holder: Server | undefined;
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

afterEach(async () => {
  if (holder?.listening) await new Promise((resolve) => holder?.close(resolve));
  holder = undefined;
});

describe('assertLocalPortFree', () => {
  test('rejects with a CliError naming the port when another process listens on it', async () => {
    holder = createServer();
    const port = await listen(holder);
    const failure = await assertLocalPortFree(port).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toBe(`Local port ${port} is already in use`);
    expect((failure as CliError).hint).toContain('--local-port');
  });

  test('resolves once the port is free again and leaves nothing listening', async () => {
    holder = createServer();
    const port = await listen(holder);
    await new Promise((resolve) => holder?.close(resolve));
    await expect(assertLocalPortFree(port)).resolves.toBeUndefined();
    holder = createServer(); // the check must not keep the port: taking it again works
    await expect(
      new Promise((resolve, reject) => {
        holder?.once('error', reject);
        holder?.listen(port, '127.0.0.1', () => resolve('listening'));
      }),
    ).resolves.toBe('listening');
  });
});
