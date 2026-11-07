import { describe, expect, test, vi } from 'vitest';
import { SESSION_REASON, ssmEndpoint, startSession, terminateSession } from '../../src/aws/session.js';
import { CliError } from '../../src/errors.js';

describe('ssmEndpoint', () => {
  test('builds the regional endpoint', () => {
    expect(ssmEndpoint('ap-northeast-2')).toBe('https://ssm.ap-northeast-2.amazonaws.com');
  });
});

describe('startSession', () => {
  test('adds Reason "ssm-commander" and returns SessionId/StreamUrl/TokenValue', async () => {
    const send = vi.fn().mockResolvedValue({ SessionId: 's-1', StreamUrl: 'wss://x', TokenValue: 'tok', extra: 1 });
    const result = await startSession({ send }, { Target: 'i-1', DocumentName: 'D', Parameters: { a: ['1'] } });
    expect(result).toEqual({ SessionId: 's-1', StreamUrl: 'wss://x', TokenValue: 'tok' });
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Target: 'i-1',
      DocumentName: 'D',
      Parameters: { a: ['1'] },
      Reason: SESSION_REASON,
    });
  });

  test('throws CliError when the response lacks TokenValue', async () => {
    const send = vi.fn().mockResolvedValue({ SessionId: 's-1', StreamUrl: 'wss://x' });
    await expect(startSession({ send }, { Target: 'i-1' })).rejects.toThrow(CliError);
    await expect(startSession({ send }, { Target: 'i-1' })).rejects.toThrow(
      'StartSession returned an incomplete response',
    );
  });
});

describe('terminateSession', () => {
  test('sends TerminateSession with the id and swallows errors from the client', async () => {
    const ok = vi.fn().mockResolvedValue({});
    await terminateSession({ send: ok }, 's-1');
    expect(ok.mock.calls[0]?.[0].input).toEqual({ SessionId: 's-1' });
    const failing = vi.fn().mockRejectedValue(new Error('already gone'));
    await expect(terminateSession({ send: failing }, 's-1')).resolves.toBeUndefined();
  });
});
