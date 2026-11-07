import { StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm';
import { CliError } from '../errors.js';
import type { Sender, SessionStart, StartSessionInput } from '../types.js';

export const SESSION_REASON = 'ssm-commander';

export function ssmEndpoint(region: string): string {
  return `https://ssm.${region}.amazonaws.com`;
}

export async function startSession(ssm: Sender, input: StartSessionInput): Promise<SessionStart> {
  const response = await ssm.send(new StartSessionCommand({ ...input, Reason: SESSION_REASON }));
  const { SessionId, StreamUrl, TokenValue } = response ?? {};
  if (!SessionId || !StreamUrl || !TokenValue) {
    throw new CliError('StartSession returned an incomplete response');
  }
  return { SessionId, StreamUrl, TokenValue };
}

/** Best-effort cleanup: the plugin usually terminates the session itself, so failures are ignored. */
export async function terminateSession(ssm: Sender, sessionId: string): Promise<void> {
  try {
    await ssm.send(new TerminateSessionCommand({ SessionId: sessionId }));
  } catch {
    // ignored on purpose
  }
}
