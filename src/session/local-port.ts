import { createServer } from 'node:net';
import { CliError } from '../errors.js';

/** The plugin listens on the loopback address; this is the address it would fail to bind. */
export const LOCAL_FORWARD_HOST = '127.0.0.1';

/**
 * Fails fast when a local port cannot be opened. session-manager-plugin reports a taken port late or not at all
 * (it opens the session first and then waits), so the check runs before StartSession.
 */
export function assertLocalPortFree(port: number, host: string = LOCAL_FORWARD_HOST): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new CliError(
            `Local port ${port} is already in use`,
            'Pass another --local-port, or stop the process that holds it (an earlier forward, for example)',
          ),
        );
      } else if (err.code === 'EACCES') {
        reject(
          new CliError(`Local port ${port} cannot be opened without privileges`, 'Pass a --local-port above 1023'),
        );
      } else {
        reject(err);
      }
    });
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}
